import express from "express";
import cors from "cors";
import Redis from "ioredis";
import fetch from "node-fetch";

const BLACKLIST_TTL_SECONDS = Number(process.env.BLACKLIST_TTL_SECONDS) || 300; // 5 minutos por defecto

// Webhook que me pasaste (se puede sobrescribir con la variable de entorno DISCORD_WEBHOOK)
const DISCORD_WEBHOOK =
  process.env.DISCORD_WEBHOOK ||
  "https://discord.com/api/webhooks/1463359351845556358/Wps8mDI5MSLQSWkFuMY9SAwirPHJ6dWKPgf6gHmkN4jaLfW2lHg8ZW7zNulGR-GxQn2f";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

if (!DISCORD_WEBHOOK) {
  console.error("ERROR: define DISCORD_WEBHOOK o incrústalo en el código.");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis(REDIS_URL);

async function sendDiscord(embed, attempts = 0) {
  try {
    const resp = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] })
    });

    if (resp.status === 204 || (resp.status >= 200 && resp.status < 300)) {
      return true;
    }

    // retry básico en caso de rate-limit
    if (resp.status === 429 && attempts < 3) {
      const retryAfter = resp.headers.get("retry-after");
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : 1000 * (attempts + 1);
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
    color: 0xff0000,
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
    color: 0x00ff00,
    description: `\`${jobId}\``,
    timestamp: new Date().toISOString()
  };
}

// Health
app.get("/", (req, res) => res.json({ status: "ok" }));

// Comprueba si está en blacklist
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

// Confirm join: crea la clave solo si NO existía (NX). No renovamos TTL si ya existía.
app.post("/confirm-join", async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId || typeof jobId !== "string") {
      return res.status(400).json({ error: "jobId missing or invalid" });
    }

    const redisKey = `blacklist:job:${jobId}`;
    const ttl = Math.max(1, BLACKLIST_TTL_SECONDS);

    // SET NX EX: solo crea la clave si no existía
    const setResult = await redis.set(redisKey, "1", "NX", "EX", ttl);

    if (setResult === "OK") {
      // clave creada: notificamos blacklist
      sendDiscord(blacklistEmbed(jobId)).catch((e) =>
        console.error("sendDiscord error:", e)
      );

      // Programamos notificar el unblacklist tras el TTL (simple; no sobrevive reinicios)
      setTimeout(async () => {
        try {
          const exists = await redis.exists(redisKey);
          if (!exists) {
            await sendDiscord(unblacklistEmbed(jobId));
          }
        } catch (err) {
          console.error("timeout unblacklist error:", err);
        }
      }, ttl * 1000);

      return res.json({
        success: true,
        jobId,
        blacklistedForSeconds: ttl,
        message: "blacklisted (new)"
      });
    } else {
      // Ya estaba en la blacklist: no enviar embed ni renovar TTL (evita spam/rejoin loop)
      return res.json({
        success: true,
        jobId,
        blacklistedForSeconds: ttl,
        message: "already blacklisted (no action taken)"
      });
    }
  } catch (err) {
    console.error("confirm-join error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// next-server: comprobar en batch con MGET
app.post("/next-server", async (req, res) => {
  try {
    const { servers } = req.body;
    if (!Array.isArray(servers) || servers.length === 0) {
      return res.status(400).json({ error: "servers array required" });
    }

    const keys = servers.map((id) => `blacklist:job:${id}`);
    const values = await redis.mget(...keys);

    const available = [];
    for (let i = 0; i < servers.length; i++) {
      if (values[i] === null) available.push(servers[i]);
    }

    if (available.length === 0) {
      return res.json({
        fallback: true,
        jobId: servers[Math.floor(Math.random() * servers.length)]
      });
    }

    const chosen = available[Math.floor(Math.random() * available.length)];
    return res.json({ fallback: false, jobId: chosen });
  } catch (err) {
    console.error("next-server error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// Start
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log("API running on port", PORT);
});

// Graceful shutdown
async function shutdown() {
  console.log("Shutting down...");
  try {
    server.close();
    await redis.quit();
  } catch (err) {
    console.error("shutdown error:", err);
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
