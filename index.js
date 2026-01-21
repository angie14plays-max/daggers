
import express from "express";
import cors from "cors";
import Redis from "ioredis";

const BLACKLIST_TTL_SECONDS =
  Number(process.env.BLACKLIST_TTL_SECONDS) || 15 * 60; // default 15 min

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis(process.env.REDIS_URL);

// fix v1
app.get("/", (req, res) => {
  res.send("working yay");
});


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



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("API running on port", PORT);
});
