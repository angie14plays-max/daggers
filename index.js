import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const STATS_WEBHOOK = process.env.STATS_WEBHOOK;

let scannedToday = 0;
let scannedThisMinute = 0;
let seenJobs = new Set();

let bestToday = {
  name: "N/A",
  value: 0
};

// reset diario
setInterval(() => {
  scannedToday = 0;
  bestToday = { name: "N/A", value: 0 };
  seenJobs.clear();
}, 24 * 60 * 60 * 1000);

// stats cada minuto
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
    await fetch(STATS_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] })
    });
  }
}, 60 * 1000);

// endpoint del scanner
app.post("/scan", (req, res) => {
  const { jobId, name, value } = req.body;

  if (!jobId || seenJobs.has(jobId)) {
    return res.json({ ignored: true });
  }

  seenJobs.add(jobId);
  scannedToday++;
  scannedThisMinute++;

  if (value > bestToday.value) {
    bestToday = { name, value };
  }

  res.json({ ok: true });
});

app.listen(3000, () => {
  console.log("Backend stats online");
});
