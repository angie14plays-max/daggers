// api experimental
const express = require('express');
const { Redis } = require('@upstash/redis');
const axios = require('axios');
const app = express();
app.use(express.json());

// conexion upstash
const redis = new Redis({
  url: 'https://calm-mullet-40937.upstash.io',
  token: 'AZ_pAAIncDFiYjMyYzQ1M2M1NTc0NDY4ODc2MWVjNTVkMmZlMmI2MHAxNDA5Mzc',
})

const CONFIG = {
    "normal": { placeId: 109983668079237, ttl: 420 }, // 7 min
    "newbie": { placeId: 96342491571673, ttl: 420 }   // 7 min
};

// cache de servers to not saturate
let serverCache = { normal: [], newbie: [], lastUpdate: 0 };

// 1. mark down server
app.post('/mark', async (req, res) => {
    const { jobId, type } = req.body;
    const key = `swarm:${type}:${jobId}`;
    await redis.set(key, "seen", { ex: CONFIG[type].ttl });
    res.send("OK");
});

// 2. find
app.get('/get-server', async (req, res) => {
    const { type, currentJobId } = req.query;
    const now = Date.now();

    try {
        // update roblox list every 10 sec
        if (now - serverCache.lastUpdate > 10000) {
            const pID = CONFIG[type].placeId;
            const resp = await axios.get(`https://games.roblox.com/v1/games/${pID}/servers/Public?limit=100`);
            serverCache[type] = resp.data.data;
            serverCache.lastUpdate = now;
        }

        const allServers = serverCache[type];
        const freshServers = [];

        // filtro de redis (memoria)
        for (let s of allServers) {
            const isBurned = await redis.get(`swarm:${type}:${s.id}`);
            if (!isBurned && s.id !== currentJobId && s.playing < s.maxPlayers) {
                freshServers.push(s.id);
            }
        }

        if (freshServers.length > 0) {
            // aleatoriedad 
            const target = freshServers[Math.floor(Math.random() * freshServers.length)];
            res.json({ jobId: target });
        } else {
            res.json({ jobId: allServers[0].id, note: "Resetting loop" });
        }
    } catch (e) { res.status(500).send("Nexus Overload"); }
});

app.listen(3000, () => console.log("working"));
