import express from "express";
import cors from "cors";
import fetch from "node-fetch";

/* ================= CONFIG ================= */

const PORT = process.env.PORT || 3000;
const PLACEID = process.env.PLACEID;
const STATS_WEBHOOK = process.env.STATS_WEBHOOK;

/* ================= APP ================= */

const app = express();
app.use(cors());
app.use(express.json());

/* ================= STATS ================= */

let serversToday = 0;
let serversThisMinute = 0;
let bestBrainrotToday = 0;
let dayStart = Date.now();

/* ========== RESET DAILY ========== */
setInterval(() => {
  if (Date.now() - dayStart >= 86400000) {
    serversToday = 0;
    bestBrainrotToday = 0;
    dayStart = Date.now();
    console.log("🔁 Daily stats reset");
  }
}, 60_000);

/* ========== SEND STATS ========== */
async function sendStats() {
  if (!STATS_WEBHOOK) return;

  await fetch(STATS_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title: "📊 Bot Stats",
        color: 0x00ff99,
        fields: [
          { name: "Servers/min", value: String(serversThisMinute), inline: true },
          { name: "Servers today", value: String(serversToday), inline: true },
          { name: "Best Brainrot Today", value: bestBrainrotToday > 0 ? `${bestBrainrotToday}M/s` : "None", inline: false }
        ],
        timestamp: new Date().toISOString()
      }]
    })
  }).catch(() => {});
}

/* ========== PER MINUTE ========== */
setInterval(() => {
  serversThisMinute = 0;
  sendStats();
}, 60_000);

/* ================= API ================= */

app.get("/", (_, res) => {
  res.json({ status: "ok", placeId: PLACEID });
});

/* ===== BOT REPORTS SERVER SCAN ===== */
app.post("/report-scan", (req, res) => {
  serversToday++;
  serversThisMinute++;
  res.json({ ok: true });
});

/* ===== BOT REPORTS BRAINROT ===== */
app.post("/report-brainrot", (req, res) => {
  const { value } = req.body;
  if (typeof value === "number" && value > bestBrainrotToday) {
    bestBrainrotToday = value;
  }
  res.json({ ok: true });
});

/* ===== NEXT SERVER (SIMPLE & FAST) ===== */
app.post("/next-server", async (req, res) => {
  try {
    const url = `https://games.roblox.com/v1/games/${PLACEID}/servers/Public?limit=100`;
    const r = await fetch(url);
    const j = await r.json();

    const servers = j.data
      .filter(s => s.playing < s.maxPlayers)
      .sort(() => Math.random() - 0.5);

    if (!servers.length) {
      return res.json({ jobId: "" });
    }

    res.json({ jobId: servers[0].id });
  } catch (e) {
    res.status(500).json({ jobId: "" });
  }
});

/* ================= START ================= */

app.listen(PORT, () => {
  console.log(`🚀 API running on port ${PORT}`);
});
