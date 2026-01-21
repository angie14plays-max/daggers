import express from "express";
import cors from "cors";
import Redis from "ioredis";
import fetch from "node-fetch";

/*
  index.js — Aggressive "no-full-server" next-server implementation

  What changed (aggressive / extreme mode):
    - New env MIN_SLOTS_REQUIRED (default 3). /next-server will only return servers
      that have at least this many free slots (maxPlayers - playing >= MIN_SLOTS_REQUIRED).
      This greatly reduces Error 772 risk at the cost of potentially fewer candidates.
    - In-memory short cache of Roblox server pages (CACHE_TTL_MS; default 700ms) to
      speed up repeated requests and reduce Roblox API latency.
    - next-server scans fewer pages (MAX_PAGES_SCAN; default 3) but prioritizes servers
      with biggest freeSlots first and returns immediately when any server meets criteria.
    - If no server meets MIN_SLOTS_REQUIRED we return a clear JSON error (jobId = "") quickly
      so the client can fallback or retry without waiting on long server-side processing.
    - Robust Roblox fetch with headers and retries to avoid 403/429.
    - confirm-join still uses SET NX EX to avoid spamming Redis.
    - More logging to help debug latencies and choices.

  Required env variables (set in Render):
    - REDIS_URL (recommended; your Upstash URL)
    - PLACEID (recommended)
    - MIN_SLOTS_REQUIRED (optional, default 3; set 4 if you want more safety)
    - CACHE_TTL_MS (optional, default 700)
    - BLACKLIST_TTL_SECONDS (optional, default 300)
    - DISCORD_WEBHOOK (optional)

  Notes:
    - This server is intentionally aggressive about avoiding full servers. If you set
      MIN_SLOTS_REQUIRED too high you may get "no_suitable_server" responses more often.
    - For the fastest client-side behavior, use the client that calls /next-server and
      teleports to the returned jobId (no per-client server fetching).
*/

const BLACKLIST_TTL_SECONDS = Number(process.env.BLACKLIST_TTL_SECONDS) || 300;
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const PLACEID = process.env.PLACEID || "";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";
const MIN_SLOTS_REQUIRED = Number(process.env.MIN_SLOTS_REQUIRED) || 3;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 700;
const MAX_PAGES_SCAN = Number(process.env.MAX_PAGES_SCAN) || 3;
const PAGE_LIMIT = Number(process.env.PAGE_LIMIT) || 100;

if (!REDIS_URL) {
  console.warn("Warning: REDIS_URL not configured. Set REDIS_URL in environment.");
}
if (!PLACEID) {
  console.warn("Warning: PLACEID not configured. /next-server will still accept client-provided placeId/servers but cannot fetch servers without PLACEID.");
}

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis(REDIS_URL);
const BLACKLIST_EXPIRATIONS_KEY = "blacklist:expirations";

// Simple in-memory cache for Roblox pages keyed by placeId+cursor
const pageCache = new Map(); // key -> { ts, data }

function cacheKey(placeId, cursor, limit) {
  return `${placeId}|${cursor || ""}|${limit || PAGE_LIMIT}`;
}

function getCachedPage(placeId, cursor, limit) {
  const key = cacheKey(placeId, cursor, limit);
  const entry = pageCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    pageCache.delete(key);
    return null;
  }
  return entry.data;
}
function setCachedPage(placeId, cursor, limit, data) {
  const key = cacheKey(placeId, cursor, limit);
  pageCache.set(key, { ts: Date.now(), data });
  // best-effort eviction: keep map small
  if (pageCache.size > 500) pageCache.clear();
}

// Discord helper (unchanged)
async function sendDiscord(embed, attempts = 0) {
  if (!DISCORD_WEBHOOK) return;
  try {
    const resp = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "ModerationAPI/1.0" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if ((resp.status >= 200 && resp.status < 300) || resp.status === 204) return true;
    if (resp.status === 429 && attempts < 3) {
      const ra = resp.headers.get("retry-after");
      const waitMs = ra ? Number(ra) * 1000 : 1000 * (attempts + 1);
      await new Promise((r) => setTimeout(r, waitMs));
      return sendDiscord(embed, attempts + 1);
    }
    const text = await resp.text().catch(() => "");
    console.error("Discord non-OK:", resp.status, text);
    return false;
  } catch (err) {
    console.error("sendDiscord error:", err);
    if (attempts < 3) {
      await new Promise((r) => setTimeout(r, 500 * (attempts + 1)));
      return sendDiscord(embed, attempts + 1);
    }
    return false;
  }
}
function blacklistEmbed(jobId) {
  return {
    title: "🚫 Server Blacklisted",
    color: 0xff0000,
    fields: [
      { name: "Place", value: `${PLACEID || "unknown"}`, inline: true },
      { name: "JobId", value: `\`${jobId}\``, inline: false },
      { name: "MinSlotsReq", value: `${MIN_SLOTS_REQUIRED}`, inline: true },
      { name: "Cooldown", value: `${BLACKLIST_TTL_SECONDS}s`, inline: true },
    ],
    timestamp: new Date().toISOString(),
  };
}

// Health
app.get("/", (_req, res) => res.json({ status: "ok", placeId: PLACEID }));

// is-blacklisted unchanged
app.get("/is-blacklisted", async (req, res) => {
  try {
    const { jobId } = req.query;
    if (!jobId) return res.status(400).json({ error: "jobId missing" });
    const exists = await redis.exists(`blacklist:job:${jobId}`);
    return res.json({ blacklisted: exists === 1 });
  } catch (err) {
    console.error("is-blacklisted error:", err);
    return res.status(500).json({ error: "internal error", detail: String(err?.message) });
  }
});

// confirm-join unchanged behavior (SET NX EX)
app.post("/confirm-join", async (req, res) => {
  try {
    const { jobId } = req.body || {};
    if (!jobId || typeof jobId !== "string") {
      return res.status(400).json({ error: "jobId missing or invalid" });
    }
    const redisKey = `blacklist:job:${jobId}`;
    const ttl = Math.max(1, BLACKLIST_TTL_SECONDS);

    const setResult = await redis.set(redisKey, "1", "NX", "EX", ttl);
    if (setResult === "OK") {
      const expireAt = Date.now() + ttl * 1000;
      await redis.zadd(BLACKLIST_EXPIRATIONS_KEY, expireAt, jobId);
      sendDiscord(blacklistEmbed(jobId)).catch((e) => console.error("sendDiscord error:", e));
      console.log("confirm-join: blacklisted", jobId);
      return res.json({ success: true, jobId: String(jobId), blacklistedForSeconds: ttl, message: "blacklisted (new)" });
    } else {
      console.log("confirm-join: already blacklisted", jobId);
      return res.json({ success: true, jobId: String(jobId), message: "already blacklisted (no action taken)" });
    }
  } catch (err) {
    console.error("confirm-join error:", err);
    return res.status(500).json({ error: "internal error", detail: String(err?.message) });
  }
});

// Robust Roblox fetch with caching
async function fetchRobloxPage(placeIdParam, cursor = null, limit = PAGE_LIMIT) {
  // try cache first
  const cached = getCachedPage(placeIdParam, cursor, limit);
  if (cached) return cached;

  const urlBase = `https://games.roblox.com/v1/games/${encodeURIComponent(placeIdParam)}/servers/Public?limit=${limit}&excludeFullGames=false`;
  const url = cursor ? `${urlBase}&cursor=${encodeURIComponent(cursor)}` : urlBase;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "User-Agent": "Mozilla/5.0 (compatible; ModerationAPI/1.0)"
        },
        timeout: 8000
      });
      const text = await resp.text();
      if (!resp.ok) {
        if (resp.status === 429) {
          const ra = resp.headers.get("retry-after");
          const waitMs = ra ? Number(ra) * 1000 : 500 * attempt;
          console.warn(`fetchRobloxPage 429, waiting ${waitMs}ms`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw new Error(`roblox status ${resp.status}: ${text}`);
      }
      const parsed = JSON.parse(text);
      setCachedPage(placeIdParam, cursor, limit, parsed);
      return parsed;
    } catch (err) {
      console.warn(`fetchRobloxPage attempt ${attempt} failed:`, err.message);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 120 * attempt));
      else throw err;
    }
  }
  throw new Error("fetchRobloxPage failed");
}

// Helper: check blacklist for array of ids (returns Set of blacklisted ids)
async function checkBlacklists(ids) {
  if (!ids || ids.length === 0) return new Set();
  const keys = ids.map((id) => `blacklist:job:${id}`);
  const mget = await redis.mget(...keys);
  const set = new Set();
  for (let i = 0; i < ids.length; i++) {
    if (mget[i] !== null) set.add(String(ids[i]));
  }
  return set;
}

// Aggressive next-server
app.post("/next-server", async (req, res) => {
  try {
    const { servers: clientServers, placeId: clientPlaceId, currentJobId } = req.body || {};

    // Fast client-provided list: filter client-sent servers first (very fast)
    if (Array.isArray(clientServers) && clientServers.length > 0) {
      // Filter out blacklisted ones and try to pick one with MIN_SLOTS_REQUIRED if server info included
      // Client may just send ids; in that case return first non-blacklisted id (as fallback)
      // We'll query Redis for blacklist and accept only non-blacklisted ids.
      const ids = clientServers.map((s) => String(s));
      const blacklistedSet = await checkBlacklists(ids);
      const available = ids.filter((id) => !blacklistedSet.has(id) && id !== String(currentJobId));
      if (available.length === 0) {
        console.log("/next-server: client list provided but no available servers (all blacklisted or current)");
        return res.json({ fallback: true, jobId: "" , error: "no_available_from_client_list"});
      }
      // Best-effort: return first available (client list presumably already filtered by proximity)
      const chosen = String(available[Math.floor(Math.random() * available.length)]);
      console.log("/next-server: chose from client list:", chosen);
      return res.json({ fallback: false, jobId: chosen });
    }

    // Otherwise backend selection: use effective placeId
    const usePlaceId = clientPlaceId || PLACEID;
    if (!usePlaceId) {
      console.warn("/next-server: no placeId available");
      return res.status(400).json({ error: "PLACEID not configured and client provided no servers" });
    }

    // Aggressive search: scan up to MAX_PAGES_SCAN pages, collect candidates with freeSlots >= MIN_SLOTS_REQUIRED
    let cursor = null;
    const candidates = []; // { id, freeSlots, playing, maxPlayers }
    const seenIds = new Set();

    for (let page = 0; page < MAX_PAGES_SCAN; page++) {
      let pageData;
      try {
        pageData = await fetchRobloxPage(usePlaceId, cursor, PAGE_LIMIT);
      } catch (err) {
        console.error("/next-server: fetchRobloxPage failed:", err.message);
        break; // if Roblox fetch failing, break and return quickly
      }

      const entries = Array.isArray(pageData?.data) ? pageData.data : [];
      if (!entries || entries.length === 0) {
        cursor = pageData?.nextPageCursor || null;
        if (!cursor) break;
        continue;
      }

      // Collect ids and check blacklist in batch
      const ids = entries.map((s) => String(s.id)).filter(Boolean);
      const blackset = await checkBlacklists(ids);

      for (let i = 0; i < entries.length; i++) {
        const s = entries[i];
        const id = String(s.id);
        if (!id || id === String(currentJobId) || blackset.has(id) || seenIds.has(id)) continue;
        seenIds.add(id);

        // Parse players and maxPlayers robustly
        const playing = s.playing != null ? Number(s.playing) : (s.playingCount != null ? Number(s.playingCount) : null);
        const maxPlayers = s.maxPlayers != null ? Number(s.maxPlayers) : (s.maxPlayersCount != null ? Number(s.maxPlayersCount) : null);

        // Access type (private) check
        const access = (s.accessType || s.type || "") + "";
        if (access.toLowerCase().includes("private")) continue;

        if (playing == null || maxPlayers == null) {
          // If counts missing we cannot safely accept with MIN_SLOTS_REQUIRED; skip for aggressive mode
          continue;
        }

        const freeSlots = maxPlayers - playing;
        if (freeSlots >= MIN_SLOTS_REQUIRED) {
          candidates.push({ id: id, freeSlots, playing, maxPlayers });
        }
      }

      // If we have any candidate, pick the best (highest freeSlots) immediately — aggressive early return
      if (candidates.length > 0) {
        // sort by freeSlots desc, pick a random among top N (to spread load)
        candidates.sort((a, b) => b.freeSlots - a.freeSlots);
        const topN = Math.min(12, candidates.length);
        const chosenEntry = candidates[Math.floor(Math.random() * topN)];
        console.log("/next-server: chosen aggressive candidate", chosenEntry);
        return res.json({ fallback: false, jobId: String(chosenEntry.id) });
      }

      cursor = pageData?.nextPageCursor || null;
      if (!cursor) break;
      // tiny throttle
      await new Promise((r) => setTimeout(r, 80));
    }

    // If no candidates found that meet MIN_SLOTS_REQUIRED, return quickly with empty jobId and explicit error.
    console.log("/next-server: no candidate met MIN_SLOTS_REQUIRED=", MIN_SLOTS_REQUIRED);
    return res.json({ fallback: true, jobId: "", error: "no_suitable_server_min_slots" });
  } catch (err) {
    console.error("next-server error:", err);
    return res.status(500).json({ error: "internal error", detail: String(err?.message) });
  }
});

// Expiration worker (unchanged)
let stopping = false;

async function processExpiredFromZsetBatch(batchSize = 100) {
  const now = Date.now();
  const expired = await redis.zrangebyscore(BLACKLIST_EXPIRATIONS_KEY, "-inf", now, "LIMIT", 0, batchSize);
  if (!expired || expired.length === 0) return 0;
  await redis.zrem(BLACKLIST_EXPIRATIONS_KEY, ...expired);
  for (const jobId of expired) {
    try {
      const key = `blacklist:job:${jobId}`;
      const exists = await redis.exists(key);
      if (!exists) {
        await sendDiscord(unblacklistEmbed(jobId));
      } else {
        const keyTtlMs = await redis.pttl(key);
        if (keyTtlMs > 0) {
          const newExpireAt = Date.now() + keyTtlMs;
          await redis.zadd(BLACKLIST_EXPIRATIONS_KEY, newExpireAt, jobId);
        }
      }
    } catch (err) {
      console.error("processExpiredFromZsetBatch error for", jobId, err);
    }
  }
  return expired.length;
}

async function backgroundExpirationWorker() {
  while (!stopping) {
    try {
      const processed = await processExpiredFromZsetBatch(100);
      if (processed === 0) await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.error("expiration worker loop error:", err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

backgroundExpirationWorker().catch((e) => console.error("expiration worker init error:", e));

// Try subscribe to keyspace notifications (best-effort)
async function trySubscribeToKeyspaceNotifications() {
  const sub = new Redis(REDIS_URL);
  try {
    try {
      await redis.config("SET", "notify-keyspace-events", "Ex");
      console.info("Tried to set notify-keyspace-events=Ex");
    } catch (err) {
      console.info("Could not set notify-keyspace-events (may be disallowed):", err.message);
    }
    const db = (redis.options && redis.options.db) ? redis.options.db : 0;
    const channel = `__keyevent@${db}__:expired`;
    sub.on("error", (err) => console.warn("subscriber redis error:", err));
    sub.on("message", async (_chan, message) => {
      try {
        if (typeof message === "string" && message.startsWith("blacklist:job:")) {
          const jobId = message.split(":").slice(2).join(":");
          await sendDiscord(unblacklistEmbed(jobId));
        }
      } catch (err) {
        console.error("keyspace handler error:", err);
      }
    });
    await sub.subscribe(channel);
    console.info("Subscribed to keyspace expired channel:", channel);
  } catch (err) {
    console.warn("subscribe to keyspace notifications failed:", err.message);
    try { await sub.quit(); } catch (_) {}
  }
}

trySubscribeToKeyspaceNotifications().catch((e) => console.error("keyspace subscribe init error:", e));

// Start server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`API running on port ${PORT} (PLACEID=${PLACEID ? PLACEID : "not set"}) MIN_SLOTS_REQUIRED=${MIN_SLOTS_REQUIRED}`);
});

// Graceful shutdown
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("Shutting down...");
  try {
    server.close(() => console.log("HTTP server closed"));
    await redis.quit();
    console.log("Redis client closed");
  } catch (err) {
    console.error("shutdown error:", err);
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
