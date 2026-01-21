import express from "express";
import cors from "cors";
import Redis from "ioredis";
import fetch from "node-fetch";

/*
  index.js — Versión lista para Render (completa)

  Requisitos de entorno (añadelos en el Dashboard de Render -> Environment):
    - REDIS_URL (ej: redis://:password@host:6379)  [RECOMENDADO]
    - PLACEID (el número de game.PlaceId de tu juego) [RECOMENDADO para que el backend obtenga servers]
    - DISCORD_WEBHOOK (opcional — para logs/embeds en Discord)
    - BLACKLIST_TTL_SECONDS (opcional, default 300)

  Start: asegúrate de que package.json tenga "start": "node index.js" y despliega en Render.
*/

const BLACKLIST_TTL_SECONDS = Number(process.env.BLACKLIST_TTL_SECONDS) || 300; // segundos
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const PLACEID = process.env.PLACEID || ""; // importante para que el backend haga fetch

if (!PLACEID) {
  console.warn("Warning: PLACEID no definido. Si el cliente no envía lista de servers, /next-server fallará.");
}

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis(REDIS_URL);
const BLACKLIST_EXPIRATIONS_KEY = "blacklist:expirations";

// ---------------- Discord helpers ----------------
async function sendDiscord(embed, attempts = 0) {
  if (!DISCORD_WEBHOOK) return;
  try {
    const resp = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if ((resp.status >= 200 && resp.status < 300) || resp.status === 204) return true;
    if (resp.status === 429 && attempts < 3) {
      const retryAfter = resp.headers.get("retry-after");
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : 1000 * (attempts + 1);
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
    color: 16711680,
    fields: [
      { name: "Game", value: "Steal a Brainrot", inline: true },
      { name: "JobId", value: `\`${jobId}\``, inline: false },
      { name: "Cooldown", value: `${BLACKLIST_TTL_SECONDS}s`, inline: true },
    ],
    timestamp: new Date().toISOString(),
  };
}

function unblacklistEmbed(jobId) {
  return {
    title: "✅ Server Unblacklisted",
    color: 65280,
    description: `\`${jobId}\``,
    timestamp: new Date().toISOString(),
  };
}

// ---------------- Health ----------------
app.get("/", (_req, res) => res.json({ status: "ok" }));

// ---------------- is-blacklisted ----------------
app.get("/is-blacklisted", async (req, res) => {
  try {
    const { jobId } = req.query;
    if (!jobId) return res.status(400).json({ error: "jobId missing" });
    const exists = await redis.exists(`blacklist:job:${jobId}`);
    return res.json({ blacklisted: exists === 1 });
  } catch (err) {
    console.error("is-blacklisted error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// ---------------- confirm-join ----------------
// Crea la clave solo si no existía (SET NX EX). Si ya existe, NO renovamos TTL ni notificamos.
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
      return res.json({ success: true, jobId, blacklistedForSeconds: ttl, message: "blacklisted (new)" });
    } else {
      // clave ya existía: no hacemos nada para evitar spam/rejoins
      console.log("confirm-join: already blacklisted", jobId);
      return res.json({ success: true, jobId, message: "already blacklisted (no action taken)" });
    }
  } catch (err) {
    console.error("confirm-join error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// ---------------- Helper: fetch Roblox page (with retries) ----------------
async function fetchRobloxPage(placeId, cursor = null, limit = 100) {
  const urlBase = `https://games.roblox.com/v1/games/${encodeURIComponent(placeId)}/servers/Public?limit=${limit}&excludeFullGames=false`;
  const url = cursor ? `${urlBase}&cursor=${encodeURIComponent(cursor)}` : urlBase;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, { method: "GET" });
      const text = await resp.text();
      if (!resp.ok) {
        if (resp.status === 429) {
          const ra = resp.headers.get("retry-after");
          const waitMs = ra ? Number(ra) * 1000 : 500 * attempt;
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw new Error(`roblox status ${resp.status}: ${text}`);
      }
      return JSON.parse(text);
    } catch (err) {
      console.warn(`fetchRobloxPage attempt ${attempt} failed:`, err.message);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 200 * attempt));
      else throw err;
    }
  }
  throw new Error("fetchRobloxPage failed");
}

// ---------------- next-server ----------------
// Si el cliente envía `servers` lo usamos (fast path).
// Si no, el backend consulta Roblox usando PLACEID (necesitas configurar PLACEID).
// Siempre devolveremos jobId como string cuando sea posible.
app.post("/next-server", async (req, res) => {
  try {
    const { servers, placeId: clientPlaceId, currentJobId } = req.body || {};

    // Fast path: client provided servers list
    if (Array.isArray(servers) && servers.length > 0) {
      const keys = servers.map((id) => `blacklist:job:${id}`);
      const values = await redis.mget(...keys);
      const available = [];
      for (let i = 0; i < servers.length; i++) {
        if (values[i] === null) available.push(String(servers[i]));
      }
      if (available.length === 0) {
        const chosen = String(servers[Math.floor(Math.random() * servers.length)]);
        console.log("/next-server: fallback to provided random:", chosen);
        return res.json({ fallback: true, jobId: chosen });
      }
      const chosen = String(available[Math.floor(Math.random() * available.length)]);
      console.log("/next-server: chose from client list:", chosen);
      return res.json({ fallback: false, jobId: chosen });
    }

    // Backend fetch path
    const usePlaceId = clientPlaceId || PLACEID;
    if (!usePlaceId) {
      console.warn("/next-server: PLACEID no configurado y cliente no envió servers.");
      return res.status(400).json({ error: "PLACEID not configured and client provided no servers" });
    }

    const maxPages = 6;
    const pageLimit = 100;
    let cursor = null;
    const candidates = [];

    for (let page = 0; page < maxPages; page++) {
      let pageData;
      try {
        pageData = await fetchRobloxPage(usePlaceId, cursor, pageLimit);
      } catch (err) {
        console.error("/next-server: fetchRobloxPage failed:", err.message);
        break;
      }

      const entries = Array.isArray(pageData?.data) ? pageData.data : [];
      if (entries.length === 0) {
        cursor = pageData?.nextPageCursor || null;
        if (!cursor) break;
        continue;
      }

      const ids = entries.map((s) => s.id).filter(Boolean).map(String);
      if (ids.length === 0) {
        cursor = pageData?.nextPageCursor || null;
        if (!cursor) break;
        continue;
      }

      const keys = ids.map((id) => `blacklist:job:${id}`);
      const mgetRes = await redis.mget(...keys);

      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const server = entries[i];
        const playing = server.playing != null ? Number(server.playing) : null;
        const maxPlayers = server.maxPlayers != null ? Number(server.maxPlayers) : null;
        let accept = true;
        if (playing != null && maxPlayers != null && playing >= maxPlayers) accept = false;
        const access = (server.accessType || server.type || "") + "";
        if (access.toLowerCase().includes("private")) accept = false;
        if (mgetRes[i] === null && accept) candidates.push(String(id));
      }

      if (candidates.length >= 20) break;
      cursor = pageData?.nextPageCursor || null;
      if (!cursor) break;
      await new Promise((r) => setTimeout(r, 120));
    }

    if (candidates.length > 0) {
      let filtered = candidates;
      if (currentJobId) filtered = candidates.filter((c) => c !== String(currentJobId));
      const chosen = String(filtered.length > 0 ? filtered[Math.floor(Math.random() * filtered.length)] : candidates[Math.floor(Math.random() * candidates.length)]);
      console.log("/next-server: chosen candidate:", chosen);
      return res.json({ fallback: false, jobId: chosen });
    }

    // Fallback: return random from first Roblox page (if any)
    try {
      const fallbackPage = await fetchRobloxPage(usePlaceId, null, 100);
      const fallbackIds = (fallbackPage?.data || []).map((s) => s.id).filter(Boolean).map(String);
      if (fallbackIds.length > 0) {
        const chosen = fallbackIds[Math.floor(Math.random() * fallbackIds.length)];
        console.log("/next-server: fallback chosen:", chosen);
        return res.json({ fallback: true, jobId: String(chosen) });
      } else {
        console.warn("/next-server: no servers available in fallback page");
        return res.status(500).json({ error: "no servers available" });
      }
    } catch (err) {
      console.error("/next-server fallback fetch failed:", err);
      return res.status(500).json({ error: "no servers available" });
    }
  } catch (err) {
    console.error("next-server error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// ---------------- Expiration worker ----------------
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

// Try subscribe to keyspace notifications (optional, may fail on managed Redis)
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

backgroundExpirationWorker().catch((e) => console.error("expiration worker init error:", e));
trySubscribeToKeyspaceNotifications().catch((e) => console.error("keyspace subscribe init error:", e));

// ---------------- Start server ----------------
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`API running on port ${PORT} (PLACEID=${PLACEID ? PLACEID : "not set"})`);
});

// ---------------- Graceful shutdown ----------------
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
