// relay
const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const app = express();
app.use(express.json());

// redis connection
const redis = new Redis("rediss://default:TU_PASSWORD@tu-db-url.upstash.io:6379");

const CONFIG = {
    "normal": { placeId: "109983668079237", ttl: 900 },
    "newbie": { placeId: "96342491571673", ttl: 300 }
};

// CACHÉ DE SERVIDORES: Render guardará la lista para no cansar a Roblox
let globalCache = {
    normal: { list: [], lastUpdate: 0 },
    newbie: { list: [], lastUpdate: 0 }
};

app.post('/mark', async (req, res) => {
    try {
        const { jobId, type } = req.body;
        await redis.setex(`swarm:${type}:${jobId}`, CONFIG[type].ttl, "seen");
        res.send("OK");
    } catch (e) { res.status(500).send("DB Busy"); }
});

app.get('/get-server', async (req, res) => {
    const { type, currentJobId } = req.query;
    if (!CONFIG[type]) return res.sendStatus(400);

    try {
        const now = Date.now();
        // update every 10 sec
        if (now - globalCache[type].lastUpdate > 10000) {
            const pID = CONFIG[type].placeId;
            // aleatoriedad
            let cursor = "";
            const skip = Math.floor(Math.random() * 5);
            for(let i = 0; i < skip; i++) {
                const pd = await axios.get(`https://games.roblox.com/v1/games/${pID}/servers/Public?limit=100&cursor=${cursor}`);
                cursor = pd.data.nextPageCursor;
                if(!cursor) break;
            }
            const response = await axios.get(`https://games.roblox.com/v1/games/${pID}/servers/Public?limit=100&cursor=${cursor}`);
            globalCache[type].list = response.data.data;
            globalCache[type].lastUpdate = now;
            console.log(`[!] Caché ${type.toUpperCase()} actualizada.`);
        }

        const allServers = globalCache[type].list;
        const available = [];

        // filtrado masivo
        for (let s of allServers) {
            const burned = await redis.get(`swarm:${type}:${s.id}`);
            if (!burned && s.id !== currentJobId && s.playing < s.maxPlayers) {
                available.push(s.id);
            }
        }

        if (available.length > 0) {
            res.json({ jobId: available[Math.floor(Math.random() * available.length)] });
        } else {
            // salvar cache
            res.json({ jobId: allServers[0].id, note: "Rotating" });
        }
    } catch (e) { 
        console.error("Error en el nexo:", e.message);
        res.status(500).send("Nexus Lag"); 
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("optimizado para bots🟢🔴"));
