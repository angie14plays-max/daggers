import express from "express";
import cors from "cors";
import Redis from "ioredis";
import fetch from "node-fetch";

/*
  Índice completo y listo para usar.

  Comportamiento:
  - POST /confirm-join { jobId }
      -> Si la clave no existía: crea la clave en Redis con EX = BLACKLIST_TTL_SECONDS,
         añade entrada en ZSET de expiraciones y envía embed "Server Blacklisted".
      -> Si ya existía la clave: no renueva TTL y no envía embed (evita spam).
  - POST /next-server
      -> El servidor backend consulta la API de Roblox por páginas (no hace fetch el cliente),
         filtra servidores ya blacklisteados (en Redis) en batch y devuelve un jobId válido.
         Si no encuentra ninguno no-blacklisted, devuelve un jobId de fallback (random) y fallback=true.
  - GET /is-blacklisted?jobId=...
      -> Comprueba si está en blacklist.
  - Worker:
      -> Intenta suscribirse a keyspace notifications para expiraciones (si Redis lo permite).
      -> Si no, un worker periódicamente procesa un ZSET (blacklist:expirations) para detectar expirados
         y enviar "Server Unblacklisted" de forma confiable entre reinicios/instancias.
*/

const BLACKLIST_TTL_SECONDS = Number(process.env.BLACKLIST_TTL_SECONDS) || 300; // default 5 minutes
const DISCORD_WEBHOOK =
  process.env.DISCORD_WEBHOOK ||
  "https://discord.com/api/webhooks/1463359351845556358/Wps8mDI5MSLQSWkFuMY9SAwirPHJ6dWKPgf6gHmkN4jaLfW2lHg8ZW7zNulGR-GxQn2f";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const PLACEID = process.env.PLACEID; // REQUIRED for /next-server backend fetching

if (!PLACEID) {
  console.warn("Warning: PLACEID not defined. Set env PLACEID to let server fetch Roblox servers.");
  // Server can still be used if client sends servers list, but user requested server-side fetching.
}

if (!DISCORD_WEBHOOK) {
  console.error("ERROR: DISCORD_WEBHOOK no definido. Define DISCORD_WEBHOOK en el entorno.");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis(REDIS_URL);
const BLACKLIST_EXPIRATIONS_KEY = "blacklist:expirations";

// -------------------- Discord helpers --------------------
async function sendDiscord(embed, attempts = 0) {
  try {
    const resp = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] })
    });

    if ((resp.status >= 200 && resp.status < 300) || resp.status === 204) {
      return true;
    }

    if (resp.status === 429 && attempts < 3) {
      const retryAfter = resp.headers.get("retry-after");
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : 1000 * (attempts + 1);
      console.warn("Discord rate limited, retrying after", waitMs, "ms");
      await new Promise((r) => setTimeout(r, waitMs));
      return sendDiscord(embed, attempts + 1);
    }

    const text = await resp.text().catch(() => "");
    console.error("Discord responded non-OK:", resp.status, text);
    return false;
  } catch (err) {
    console.error("Error sending to Discord:", err);
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
      { name: "Cooldown", value: `${BLACKLIST_TTL_SECONDS}s`, inline: true }
    ],
    timestamp: new Date().toISOString()
  };
}

function unblacklistEmbed(jobId) {
  return {
    title: "✅ Server Unblacklisted",
    color: 65280,
    description: `\`${jobId}\``,
    timestamp: new Date().toISOString()
  };
}

// -------------------- Health --------------------
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

// -------------------- Check blacklist --------------------
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

// -------------------- Confirm join (blacklist) --------------------
app.post("/confirm-join", async (req, res) => {
  try {
    const { jobId } = req.body || {};
    if (!jobId || typeof jobId !== "string") {
      return res.status(400).json({ error: "jobId missing or invalid" });
    }

    const redisKey = `blacklist:job:${jobId}`;
    const ttl = Math.max(1, BLACKLIST_TTL_SECONDS);

    // Crear la clave solo si no existía (NX). Si ya existe: no renovar TTL ni enviar embed.
    const setResult = await redis.set(redisKey, "1", "NX", "EX", ttl);

    if (setResult === "OK") {
      // Guardar expiración en ZSET para worker fiable entre instancias
      const expireAt = Date.now() + ttl * 1000;
      await redis.zadd(BLACKLIST_EXPIRATIONS_KEY, expireAt, jobId);

      // Enviar embed de blacklist (una sola vez)
      sendDiscord(blacklistEmbed(jobId)).catch((e) => console.error("sendDiscord error:", e));

      return res.json({ success: true, jobId, blacklistedForSeconds: ttl, message: "blacklisted (new)" });
    } else {
      // Ya estaba en blacklist: no hacemos nada (evita spam / rejoin loops)
      return res.json({ success: true, jobId, message: "already blacklisted (no action taken)" });
    }
  } catch (err) {
    console.error("confirm-join error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// -------------------- Helper: Roblox fetch with retries --------------------
async function fetchRobloxServersPage(cursor = null, limit = 100) {
  // require PLACEID to be set for server-side fetching
  if (!PLACEID) throw new Error("PLACEID not configured in environment");

  const urlBase = `https://games.roblox.com/v1/games/${PLACEID}/servers/Public?limit=${limit}&excludeFullGames=false`;
  const url = cursor ? `${urlBase}&cursor=${encodeURIComponent(cursor)}` : urlBase;

  // retries basic
  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    try {
      const resp = await fetch(url, { method: "GET" });
      const text = await resp.text();
      if (!resp.ok) {
        // If rate limited, wait Retry-After
        if (resp.status === 429) {
          const ra = resp.headers.get("retry-after");
          const waitMs = ra ? Number(ra) * 1000 : 1000 * attempts;
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw new Error(`roblox fetch status ${resp.status}: ${text}`);
      }
      const json = JSON.parse(text);
      return json;
    } catch (err) {
      console.warn("fetchRobloxServersPage attempt failed:", attempts, err.message);
      await new Promise((r) => setTimeout(r, 250 * attempts));
      if (attempts >= 3) throw err;
    }
  }
  throw new Error("failed to fetch roblox servers pages");
}

// -------------------- Pick next server (backend fetches Roblox) --------------------
app.post("/next-server", async (req, res) => {
  try {
    // Optional: the client may send servers list; prefer that if present and non-empty.
    const { servers } = req.body || {};

    // If client provided a servers list, use it (fast path)
    if (Array.isArray(servers) && servers.length > 0) {
      // Check blacklist in batch
      const keys = servers.map((id) => `blacklist:job:${id}`);
      const values = await redis.mget(...keys); // null if not exist
      const available = [];
      for (let i = 0; i < servers.length; i++) {
        if (values[i] === null) available.push(servers[i]);
      }
      if (available.length === 0) {
        // fallback: return random from provided
        return res.json({ fallback: true, jobId: servers[Math.floor(Math.random() * servers.length)] });
      }
      const chosen = available[Math.floor(Math.random() * available.length)];
      return res.json({ fallback: false, jobId: chosen });
    }

    // Otherwise, backend will fetch Roblox servers itself.
    if (!PLACEID) {
      return res.status(400).json({ error: "PLACEID not configured on server and client did not provide servers list" });
    }

    const maxPages = 6;
    const pageLimit = 100;
    let cursor = null;
    let collected = [];
    for (let p = 0; p < maxPages; p++) {
      let pageData;
      try {
        pageData = await fetchRobloxServersPage(cursor, pageLimit);
      } catch (err) {
        console.error("Error fetching Roblox servers:", err);
        break;
      }

      const entries = pageData && pageData.data ? pageData.data : [];
      // Prepare batch keys
      const ids = entries.map((s) => s.id).filter(Boolean);
      if (ids.length === 0) {
        cursor = pageData && pageData.nextPageCursor ? pageData.nextPageCursor : null;
        if (!cursor) break;
        continue;
      }

      // Check blacklist for this batch
      const keys = ids.map((id) => `blacklist:job:${id}`);
      const mgetRes = await redis.mget(...keys); // array matching ids

      for (let i = 0; i < ids.length; i++) {
        // filter out full servers if info available
        const server = entries[i];
        const playing = server.playing != null ? Number(server.playing) : null;
        const maxPlayers = server.maxPlayers != null ? Number(server.maxPlayers) : null;
        let accept = true;
        if (playing != null && maxPlayers != null && playing >= maxPlayers) accept = false;
        // Some servers may be private/vip - skip
        const access = (server.accessType || server.type || "") + "";
        if (access.toLowerCase().includes("private")) accept = false;

        if (mgetRes[i] === null && accept) {
          collected.push(ids[i]);
        }
      }

      // stop early if collected enough candidates
      if (collected.length >= 20) break;

      cursor = pageData && pageData.nextPageCursor ? pageData.nextPageCursor : null;
      if (!cursor) break;
      // small pause to avoid aggressive querying
      await new Promise((r) => setTimeout(r, 120));
    }

    // If found at least one non-blacklisted candidate, return random of them
    if (collected.length > 0) {
      const chosen = collected[Math.floor(Math.random() * collected.length)];
      return res.json({ fallback: false, jobId: chosen });
    }

    // Fallback: fetch a single page and return random job even if blacklisted (prevents clients stuck)
    try {
      const fallbackPage = await fetchRobloxServersPage(null, 100);
      const fallbackIds = (fallbackPage && fallbackPage.data ? fallbackPage.data.map((s) => s.id).filter(Boolean) : []);
      if (fallbackIds.length > 0) {
        return res.json({ fallback: true, jobId: fallbackIds[Math.floor(Math.random() * fallbackIds.length)] });
      } else {
        return res.status(500).json({ error: "no servers available" });
      }
    } catch (err) {
      console.error("fallback page fetch failed:", err);
      return res.status(500).json({ error: "no servers available" });
    }
  } catch (err) {
    console.error("next-server error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// -------------------- Background worker para expiraciones --------------------
let stopping = false;

async function processExpiredFromZsetBatch(batchSize = 100) {
  const now = Date.now();
  const expiredMembers = await redis.zrangebyscore(
    BLACKLIST_EXPIRATIONS_KEY,
    "-inf",
    now,
    "LIMIT",
    0,
    batchSize
  );

  if (!expiredMembers || expiredMembers.length === 0) return 0;

  // intentamos removerlos del ZSET para que no los procese otra instancia
  await redis.zrem(BLACKLIST_EXPIRATIONS_KEY, ...expiredMembers);

  for (const jobId of expiredMembers) {
    try {
      const redisKey = `blacklist:job:${jobId}`;
      const exists = await redis.exists(redisKey);
      if (!exists) {
        // Notificamos unblacklist únicamente si ya no existe la clave
        await sendDiscord(unblacklistEmbed(jobId));
      } else {
        // Si aún existe, reprogramamos según TTL real
        const keyTtlMs = await redis.pttl(redisKey);
        if (keyTtlMs > 0) {
          const newExpireAt = Date.now() + keyTtlMs;
          await redis.zadd(BLACKLIST_EXPIRATIONS_KEY, newExpireAt, jobId);
        }
      }
    } catch (err) {
      console.error("Error procesando expirado para", jobId, err);
    }
  }

  return expiredMembers.length;
}

async function backgroundExpirationWorker() {
  try {
    while (!stopping) {
      try {
        const processed = await processExpiredFromZsetBatch(100);
        if (processed === 0) {
          // si no hay trabajo, esperar un poco
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (err) {
        console.error("expiration worker loop error:", err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  } catch (err) {
    console.error("backgroundExpirationWorker fatal:", err);
  }
}

// -------------------- Intento de suscribirse a keyspace notifications --------------------
async function trySubscribeToKeyspaceNotifications() {
  // Cliente separado para subscriber
  const sub = new Redis(REDIS_URL);
  try {
    // Intentamos habilitar notificaciones si el servidor lo permite
    try {
      await redis.config("SET", "notify-keyspace-events", "Ex");
      console.info("Intentado config set notify-keyspace-events=Ex");
    } catch (err) {
      console.info("No se pudo setear notify-keyspace-events (posiblemente no permitido):", err.message);
    }

    // Determinar db index (por defecto 0)
    const db = (redis.options && redis.options.db) ? redis.options.db : 0;
    const channel = `__keyevent@${db}__:expired`;

    sub.on("error", (err) => console.warn("subscriber redis error:", err));
    sub.on("message", async (chan, message) => {
      try {
        if (typeof message === "string" && message.startsWith("blacklist:job:")) {
          const jobId = message.split(":").slice(2).join(":");
          // enviar notificación de unblacklist
          await sendDiscord(unblacklistEmbed(jobId));
        }
      } catch (err) {
        console.error("error processing keyspace message:", err);
      }
    });

    await sub.subscribe(channel);
    console.info("Subscribed to keyspace expired channel:", channel);
    // No cerramos el sub para que permanezca activo
  } catch (err) {
    console.warn("No fue posible suscribirse a keyspace notifications:", err.message);
    try {
      await sub.quit();
    } catch (_) {}
  }
}

// Iniciar worker y suscripción
backgroundExpirationWorker().catch((e) => console.error("worker init error:", e));
trySubscribeToKeyspaceNotifications().catch((e) => console.error("keyspace subscribe init error:", e));

// -------------------- Start server --------------------
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log("API running on port", PORT);
});

// Shutdown limpio
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("Shutting down...");
  try {
    server.close(() => console.log("HTTP server closed"));
    await redis.quit();
    console.log("Redis client closed");
  } catch (err) {
    console.error("Error during shutdown:", err);
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
