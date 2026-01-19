// relay
const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const app = express();
app.use(express.json());

// redis connection fix
// not reset
const redis = new Redis("rediss://default:AZ_pAAIncDFiYjMyYzQ1M2M1NTc0NDY4ODc2MWVjNTVkMmZlMmI2MHAxNDA5Mzc@calm-mullet-40937.upstash.io:6379", {
    tls: {
        rejectUnauthorized: false // fix v1
    },
    maxRetriesPerRequest: null, // fix v2
    enableReadyCheck: false
});

redis.on('error', (err) => console.log('[-] Redis Connection Error:', err.message));
redis.on('connect', () => console.log('[+] Conectado a la Memoria Eterna (Upstash) 🟢'));

const CONFIG = {
    "normal": { placeId: "109983668079237", ttl: 900 },
    "newbie": { placeId: "96342491571673", ttl: 300 }
};

let globalCache = {
    normal: { list: [], lastUpdate: 0 },
    newbie: { list: [], lastUpdate: 0 }
};

app.post('/mark', async (req, res) => {
    try {
        const { jobId, type } = req.body;
        if (!CONFIG[type]) return res.sendStatus(400);
        await redis.setex(`swarm:${type}:${jobId}`, CONFIG[type].ttl, "seen");
        res.send("OK");
    } catch (e) { res.status(500).send("Redis Busy"); }
});

app.get('/get-server', async (req, res) => {
    const { type, currentJobId } = req.query;
    if (!CONFIG[type]) return res.sendStatus(400);

    try {
        const now = Date.now();
        if (now - globalCache[type].lastUpdate > 12000) { // caché 
            const pID = CONFIG[type].placeId;
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
            console.log(`[!] Lista ${type.toUpperCase()} actualizada.`);
        }

        const allServers = globalCache[type].list;
        const available = [];

        for (let s of allServers) {
            const burned = await redis.get(`swarm:${type}:${s.id}`);
            if (!burned && s.id !== currentJobId && s.playing < s.maxPlayers) {
                available.push(s.id);
            }
        }

        if (available.length > 0) {
            res.json({ jobId: available[Math.floor(Math.random() * available.length)] });
        } else {
            res.json({ jobId: allServers[0].id, note: "Rotating" });
        }
    } catch (e) { res.status(500).send("Nexus Overload"); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("working 🟢🔴"));
