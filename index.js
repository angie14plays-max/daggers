// ─────────────────────────────
// 1️⃣ IMPORTS (ARRIBA DEL TODO)
// ─────────────────────────────
import express from "express";
import cors from "cors";
import Redis from "ioredis";

// ─────────────────────────────
// 2️⃣ CONFIGURACIÓN GLOBAL
// (AQUÍ REEMPLAZASTE EL TTL)
// ─────────────────────────────
const BLACKLIST_TTL_SECONDS =
  Number(process.env.BLACKLIST_TTL_SECONDS) || 15 * 60; // default 15 min

// ─────────────────────────────
// 3️⃣ CREAR APP + MIDDLEWARES
// ─────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────
// 4️⃣ CONEXIÓN A REDIS (UNA SOLA VEZ)
// ─────────────────────────────
const redis = new Redis(process.env.REDIS_URL);

// ─────────────────────────────
// 5️⃣ ENDPOINTS (TODOS VAN AQUÍ)
// ─────────────────────────────

// 5.1 Health check
app.get("/", (req, res) => {
  res.send("Moderation API with Redis running");
});

// 5.2 CONFIRMAR QUE YA ENTRASTE AL SERVER
app.post("/confirm-join", async (req, res) => {
  try {
    const { jobId } = req.body;

    if (!jobId) {
      return res.status(400).json({ error: "jobId missing" });
    }

    const redisKey = `blacklist:job:${jobId}`;

    await redis.set(redisKey, "1", "EX", BLACKLIST_TTL_SECONDS);

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

// 5.3 PEDIR SIGUIENTE SERVER NO BLACKLISTEADO
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

      if (!exists) {
        available.push(jobId);
      }
    }

    if (available.length === 0) {
      return res.json({
        fallback: true,
        jobId: servers[Math.floor(Math.random() * servers.length)]
      });
    }

    const chosen =
      available[Math.floor(Math.random() * available.length)];

    return res.json({
      fallback: false,
      jobId: chosen
    });
  } catch (err) {
    console.error("next-server error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// ─────────────────────────────
// 6️⃣ LISTEN (SIEMPRE AL FINAL)
// ─────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("API running on port", PORT);
});
