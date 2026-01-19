// [[ DAVID'S LEGION API v4.2 - STABLE VERSION ]]
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const app = express();
app.use(express.json());

// Memoria de la Legión
let serverDatabase = new Map(); // UUID -> { jobId, type }
let blacklist = new Map();      // UUID -> expiryTime

// 1. ENDPOINT: REGISTRAR Y BLACKLISTEAR (Sincronizado con Lua)
app.post('/api/blacklist', (req, res) => {
    const { robloxJobId, placeType } = req.body;
    const minutes = 15; // Tiempo de blacklist
    
    // Crear o buscar UUID
    let uuid = uuidv4();
    serverDatabase.set(uuid, { robloxJobId, placeType });
    
    // Meter en Blacklist
    const expiry = Date.now() + (minutes * 60 * 1000);
    blacklist.set(uuid, expiry);
    
    console.log(`[🚫] Bloqueado: ${robloxJobId} (${placeType}) por ${minutes}min`);
    res.json({ success: true, uuid });
});

// 2. ENDPOINT: BUSCADOR FRESCO (Sincronizado con Lua)
app.get('/api/next-server', async (req, res) => {
    const type = req.query.type || 'normal';
    const placeId = (type === 'newplayers') ? 96342491571673 : 109983668079237;
    
    try {
        // Salto global aleatorio
        let cursor = "";
        const skip = Math.floor(Math.random() * 5);
        for(let i = 0; i < skip; i++) {
            const r = await axios.get(`https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=100&cursor=${cursor}`);
            cursor = r.data.nextPageCursor;
            if(!cursor) break;
        }

        const response = await axios.get(`https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=100&cursor=${cursor}`);
        const servers = response.data.data;
        const now = Date.now();

        // Filtrar servidores que NO estén en la blacklist de UUID
        const candidates = servers.filter(s => {
            let isBlacklisted = false;
            for (let [uuid, data] of serverDatabase.entries()) {
                if (data.robloxJobId === s.id && blacklist.has(uuid) && blacklist.get(uuid) > now) {
                    isBlacklisted = true;
                    break;
                }
            }
            return !isBlacklisted && s.playing < s.maxPlayers;
        });

        if (candidates.length > 0) {
            const target = candidates[Math.floor(Math.random() * candidates.length)];
            res.json({ jobId: target.id, freshCount: candidates.length });
        } else {
            res.json({ jobId: servers[0].id, note: "Rotación completa" });
        }
    } catch (e) {
        res.status(500).json({ error: "Error en red de Roblox" });
    }
});

app.listen(process.env.PORT || 3000, () => console.log("CEREBRO ACTIVO 🟢"));
