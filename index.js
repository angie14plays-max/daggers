import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PLACEID = process.env.PLACEID || "109983668079237";
const MIN_FREE_SLOTS = 4; // 🔑 CLAVE anti 279
const PORT = process.env.PORT || 3000;

app.get("/", (_, res) => {
  res.json({ status: "ok" });
});

app.post("/next-server", async (_, res) => {
  try {
    const url = `https://games.roblox.com/v1/games/${PLACEID}/servers/Public?limit=100`;
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const j = await r.json();

    if (!j.data || !Array.isArray(j.data)) {
      return res.json({ retry: true });
    }

    const candidates = j.data.filter(s => {
      if (typeof s.playing !== "number") return false;
      if (typeof s.maxPlayers !== "number") return false;
      return (s.maxPlayers - s.playing) >= MIN_FREE_SLOTS;
    });

    if (candidates.length === 0) {
      return res.json({ retry: true });
    }

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    return res.json({ jobId: pick.id });

  } catch (err) {
    return res.json({ retry: true });
  }
});

app.listen(PORT, () => {
  console.log("API UP | PLACEID:", PLACEID, "| MIN_FREE_SLOTS:", MIN_FREE_SLOTS);
});
