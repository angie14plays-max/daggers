import express from "express";
import cors from "cors";
import Redis from "ioredis";
import fetch from "node-fetch";

const BLACKLIST_TTL_SECONDS =
  Number(process.env.BLACKLIST_TTL_SECONDS) || 5 * 60;

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
if (!DISCORD_WEBHOOK) {
  console.error(
    "ERROR: DISCORD_WEBHOOK no definido. Define la var de entorno DISCORD_WEBHOOK"
  );
  process.exit(1);
}

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis(REDIS_URL);

// ZSET para controlar expiraciones de forma confiable entre instancias
const BLACKLIST_EXPIRATIONS_KEY = "blacklist:expirations";

//
// --------------------
// Discord helpers
// --------------------
//
async function sendDiscord(embed) {
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] })
    });
  } catch (err) {
    console.error("Discord error:", err);
  }
}

function blacklistEmbed(jobId) {
  return {
    title: "🚫 Server Blacklisted",
    color: 16711680,
    fields: [
      { name: "Game", value: "Steal a Brainrot", inline: true },
      { name: "JobId", value: `\`${jobId}\``, inline: false },
      {
        name: "Cooldown",
        value: `${BLACKLIST_TTL_SECONDS}s`,
        inline: true
      }
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

//
// --------------------
// Health check
// --------------------
//
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

//
// --------------------
// Check blacklist
// --------------------
//
app.get("/is-blacklisted", async (req, res) => {
  try {
    const { jobId } = req.query;
    if (!jobId) {
      return res.status(400).json({ error: "jobId missing" });
    }

    const redisKey = `blacklist:job:${jobId}`;
    const exists = await redis.exists(redisKey);

    return res.json({
      blacklisted: exists === 1
    });
  } catch (err) {
    console.error("is-blacklisted error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

//
// --------------------
// Confirm join (COOLDOWN)
// --------------------
//
app.post("/confirm-join", async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId || typeof jobId !== "string") {
      return res.status(400).json({ error: "jobId missing or invalid" });
    }

    const redisKey = `blacklist:job:${jobId}`;
    const ttlSeconds = Math.max(1, BLACKLIST_TTL_SECONDS);

    // Guardar cooldown con expiración
    await redis.set(redisKey, "1", "EX", ttlSeconds);

    // Guardar expiración en ZSET para notificación fiable
    const expireAt = Date.now() + ttlSeconds * 1000;
    await redis.zadd(BLACKLIST_EXPIRATIONS_KEY, expireAt, jobId);

    // Discord log de blacklist
    await sendDiscord(blacklistEmbed(jobId));

    return res.json({
      success: true,
      jobId,
      blacklistedForSeconds: ttlSeconds
    });
  } catch (err) {
    console.error("confirm-join error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

//
// --------------------
// Pick next server (optimizado)
// --------------------
//
app.post("/next-server", async (req, res) => {
  try {
    const { servers } = req.body;

    if (!Array.isArray(servers) || servers.length === 0) {
      return res.status(400).json({ error: "servers array required" });
    }

    // Construir keys y pedir en batch
    const keys = servers.map((jobId) => `blacklist:job:${jobId}`);
    const values = await redis.mget(...keys); // devuelve null si no existe

    const available = [];
    for (let i = 0; i < servers.length; i++) {
      if (values[i] === null) {
        available.push(servers[i]);
      }
    }

    if (available.length === 0) {
      return res.json({
        fallback: true,
        jobId: servers[Math.floor(Math.random() * servers.length)]
      });
    }

    const chosen = available[Math.floor(Math.random() * available.length)];

    return res.json({
      fallback: false,
      jobId: chosen
    });
  } catch (err) {
    console.error("next-server error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

//
// --------------------
// Background worker para notificaciones de expiración
// --------------------
//
let stopping = false;

async function processExpiredFromZsetBatch(batchSize = 100) {
  // Obtenemos members con score <= now
  const now = Date.now();
  const expiredMembers = await redis.zrangebyscore(
    BLACKLIST_EXPIRATIONS_KEY,
    "-inf",
    now,
    "LIMIT",
    0,
    batchSize
  );

  if (!expiredMembers || expiredMembers.length === 0) {
    return 0;
  }

  // Intentamos removerlos (para evitar procesarlos simultáneamente desde otra instancia)
  if (expiredMembers.length > 0) {
    await redis.zrem(BLACKLIST_EXPIRATIONS_KEY, ...expiredMembers);
  }

  for (const jobId of expiredMembers) {
    try {
      const redisKey = `blacklist:job:${jobId}`;
      const exists = await redis.exists(redisKey);
      if (!exists) {
        // Solo notificar si ya no existe la clave
        await sendDiscord(unblacklistEmbed(jobId));
      } else {
        // Si aún existe (race), reprogramamos en el ZSET usando su TTL real
        const keyTtl = await redis.pttl(redisKey);
        if (keyTtl > 0) {
          const newExpireAt = Date.now() + keyTtl;
          await redis.zadd(BLACKLIST_EXPIRATIONS_KEY, newExpireAt, jobId);
        }
      }
    } catch (err) {
      console.error("error procesando expirado para", jobId, err);
    }
  }

  return expiredMembers.length;
}

async function backgroundExpirationWorker() {
  try {
    while (!stopping) {
      // procesar batches
      try {
        const processed = await processExpiredFromZsetBatch(100);
        if (processed === 0) {
          // pequeña espera cuando no hay trabajo
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (err) {
        console.error("expiration worker loop error:", err);
        // backoff
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  } catch (err) {
    console.error("backgroundExpirationWorker fatal:", err);
  }
}

// Intento de suscripción a Keyspace notifications (mejor cuando Redis lo permite)
async function trySubscribeToKeyspaceNotifications() {
  // Hacemos un cliente separado para subscription
  const sub = new Redis(REDIS_URL);
  try {
    // Intentar habilitar notificaciones (si está permitido)
    try {
      await redis.config("SET", "notify-keyspace-events", "Ex");
      console.info("Configurado notify-keyspace-events=Ex (si el servidor permite CONFIG SET)");
    } catch (err) {
      console.info("No se pudo setear notify-keyspace-events (puede que no esté permitido):", err.message);
    }

    // Determinar DB (por defecto 0)
    const db = (redis.options && redis.options.db) ? redis.options.db : 0;
    const channel = `__keyevent@${db}__:expired`;

    sub.on("error", (err) => console.warn("subscriber redis error:", err));
    sub.on("message", async (chan, message) => {
      try {
        // message es la clave que expiró
        if (typeof message === "string" && message.startsWith("blacklist:job:")) {
          const jobId = message.split(":").slice(2).join(":");
          // notificar unblacklist
          await sendDiscord(unblacklistEmbed(jobId));
        }
      } catch (err) {
        console.error("error procesando keyspace message:", err);
      }
    });

    await sub.subscribe(channel);
    console.info("Subscribed to keyspace expired channel:", channel);
    // No retornamos el sub; lo mantenemos abierto hasta shutdown
  } catch (err) {
    console.warn("No fue posible suscribirse a keyspace notifications:", err.message);
    try {
      await sub.quit();
    } catch (_) {}
  }
}

backgroundExpirationWorker().catch((e) => console.error("worker init error:", e));
trySubscribeToKeyspaceNotifications().catch((e) =>
  console.error("keyspace subscribe init error:", e)
);

//
// --------------------
// Start server
// --------------------
//
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log("API running on port", PORT);
});

async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("Shutting down...");
  try {
    server.close(() => {
      console.log("HTTP server closed");
    });
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
