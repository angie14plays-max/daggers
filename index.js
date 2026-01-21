import express from "express";
import fetch from "node-fetch";
import Redis from "ioredis";

const app = express();
app.use(express.json());

const STATS_WEBHOOK = process.env.STATS_WEBHOOK;
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const redis = new Redis(REDIS_URL);

let scannedToday = 0;
let scannedThisMinute = 0;
let seenJobs = new Set();
let bestToday = { name: "N/A", value: 0 };

// Reset diario
setInterval(() => {
  scannedToday = 0;
  bestToday = { name: "N/A", value: 0 };
  seenJobs.clear();
}, 24 * 60 * 60 * 1000);

// Stats cada minuto
setInterval(async () => {
  const embed = {
    title: "🤖 Brainrot Bot Stats",
    color: 0x00ffaa,
    fields: [
      { name: "Servers / min", value: String(scannedThisMinute), inline: true },
      { name: "Servers hoy", value: String(scannedToday), inline: true },
      { name: "Mejor Brainrot", value: bestToday.name, inline: false },
      { name: "Producción", value: bestToday.value > 0 ? `${bestToday.value}/s` : "N/A", inline: false }
    ],
    timestamp: new Date().toISOString()
  };
  scannedThisMinute = 0;

  if (STATS_WEBHOOK) {
    try {
      await fetch(STATS_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] })
      });
    } catch (e) {
      console.error("Discord webhook error:", e);
    }
  }
}, 60 * 1000);

// Endpoint del scanner
app.post("/scan", (req, res) => {
  const { jobId, name, value } = req.body;
  if (!jobId || seenJobs.has(jobId)) return res.json({ ignored: true });

  seenJobs.add(jobId);
  scannedToday++;
  scannedThisMinute++;

  if (value > bestToday.value) bestToday = { name, value };

  res.json({ ok: true });
});

// Blacklist endpoint
app.post("/confirm-join", async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId) return res.status(400).json({ error: "jobId missing" });
    const setResult = await redis.set(`blacklist:${jobId}`, "1", "NX", "EX", 300);
    res.json({ success: setResult === "OK", jobId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// Check blacklist
app.get("/is-blacklisted", async (req, res) => {
  const { jobId } = req.query;
  const exists = await redis.exists(`blacklist:${jobId}`);
  res.json({ blacklisted: exists === 1 });
});

app.listen(3000, () => {
  console.log("Backend stats online");
});
