// blossom
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ram
let serverPool = {
    normal: { queue: [], seen: new Set(), lastFetch: 0, placeId: 109983668079237 },
    newbie: { queue: [], seen: new Set(), lastFetch: 0, placeId: 96342491571673 }
};

const TTL = 12 * 60 * 1000; // forget time

async function fetchServers(type) {
    const world = serverPool[type];
    try {
        console.log(`[!] Extrayendo nuevos servidores para canal: ${type.toUpperCase()}`);
        // aleatory
        let cursor = "";
        const randomPage = Math.floor(Math.random() * 40); 
        for(let i = 0; i < randomPage; i++) {
            const pd = await axios.get(`https://games.roblox.com/v1/games/${world.placeId}/servers/Public?limit=100&cursor=${cursor}`);
            cursor = pd.data.nextPageCursor;
            if(!cursor) break;
        }

        const resp = await axios.get(`https://games.roblox.com/v1/games/${world.placeId}/servers/Public?limit=100&cursor=${cursor || ""}`);
        const servers = resp.data.data;
        
        // fix v2
        servers.forEach(s => {
            if (!world.seen.has(s.id) && s.playing < s.maxPlayers) {
                world.queue.push(s.id);
            }
        });
        
        world.lastFetch = Date.now();
    } catch (e) { console.error("Error en el API de Roblox"); }
}

// fix v3
app.get('/get-target', async (req, res) => {
    const { type, currentJobId } = req.query;
    if (!serverPool[type]) return res.sendStatus(400);

    const world = serverPool[type];

    // blacklist
    if (currentJobId) {
        world.seen.add(currentJobId);
        setTimeout(() => { world.seen.delete(currentJobId); }, TTL);
    }

    // ask for
    if (world.queue.length < 5) {
        await fetchServers(type);
    }

    // fix v4
    const nextJobId = world.queue.shift();

    if (nextJobId) {
        res.json({ jobId: nextJobId, status: "assigned", remaining: world.queue.length });
    } else {
        res.status(503).json({ error: "Waiting for queue refresh" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("working api 🟢"));
