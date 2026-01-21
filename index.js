import express from "express";
import cors from "cors";
import Redis from "ioredis";
import fetch from "node-fetch";

const BLACKLIST_TTL_SECONDS =
  Number(process.env.BLACKLIST_TTL_SECONDS) || 5 * 60; // 5 minutos

const DISCORD_WEBHOOK =
  "https://discord.com/api/webhooks/1463359351845556358/Wps8mDI5MSLQSWkFuMY9SAwirPHJ6dWKPgf6gHmkN4jaLfW2lHg8ZW7zNulGR-GxQn2f";

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis(process.env.REDIS_URL);

// --------------------
// Discord helpers
// --------------------
async function sendDiscord(embed) {
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] })
    });
  } catch (err) {
    console.error("Discord webhook error:", err);
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

// --------------------
// Health check
// --------------------
app.get("/", (req, res) => {
  res.send("working yay");
});

// --------------------
// CONFIRM JOIN
// Roblox llama esto cuando entra a un server
// --------------------
app.post("/confirm-join", async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId) {
      return res.status(400).json({ error: "jobId missing" });
    }

    const redisKey = `blacklist:job:${jobId}`;

    // Guardar en blacklist
    await redis.set(redisKey, "1", "EX", BLACKLIST_TTL_SECONDS);

    // Notificar a Discord
    await sendDiscord(blacklistEmbed(jobId));

    // Programar aviso de desbloqueo
    setTimeout(async () => {
      const stillExists = await redis.exists(redisKey);
      if (!stillExists) {
        await sendDiscord(unblacklistEmbed(jobId));
      }
    }, BLACKLIST_TTL_SECONDS * 1000);

    return res.json({
      success: true,
      jobId,
      blacklistedForSeconds: BLACKLIST_TTL_SECONDS
    });
  } catch (err) {
    console.error("confirm-join error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// --------------------
// NEXT SERVER
// Devuelve un server NO blacklisted
// --------------------
app.post("/next-server", async (req, res) => {
  try {
    const { servers } = req.body;

    if (!Array.isArray(servers) || servers.length === 0) {
      return res.status(400).json({ error: "servers array required" });
    }

    const available = [];

    for (const jobId of servers) {
      const redisKey = `blacklist:job:${jobId}`;
      const exists = await redis.exists(redisKey);
      if (!exists) available.push(jobId);
    }

    if (available.length === 0) {
      return res.json({
        fallback: true,
        jobId: servers[Math.floor(Math.random() * servers.length)]
      });
    }

    return res.json({
      fallback: false,
      jobId:
        available[Math.floor(Math.random() * available.length)]
    });
  } catch (err) {
    console.error("next-server error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("API running on port", PORT);
});
