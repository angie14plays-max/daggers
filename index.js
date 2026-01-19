const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const app = express();
app.use(express.json());

const CONFIG = {
    NORMAL_PLACE_ID: '109983668079237',   // Servidores normales
    NEW_PLAYERS_PLACE_ID: '96342491571673', // New players
    BLACKLIST_DURATION_MS: 10 * 60 * 1000, // 10 minutos
    PORT: process.env.PORT || 3000
};

// Blacklist en memoria: { "jobId": timestamp }
let blacklist = new Map();

// CONSULTA SERVIDORES REALES DE ROBLOX
async function getActiveServers(placeId) {
    const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Desc&limit=100`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        return data.data || []; // Array de servidores reales {id, playing, maxPlayers}
    } catch (error) {
        console.error('Error fetching servers:', error);
        return [];
    }
}

// FILTRA quitando blacklisted
function filterBlacklisted(servers) {
    const now = Date.now();
    return servers.filter(server => {
        const blacklistTime = blacklist.get(server.id);
        if (!blacklistTime) return true; // No está en blacklist
        return (now - blacklistTime) > CONFIG.BLACKLIST_DURATION_MS; // Ya pasó el tiempo
    });
}

// ENDPOINT 1: "Registra este JobId" (POST /api/visited)
app.post('/api/visited', (req, res) => {
    const { jobId } = req.body;
    if (!jobId) return res.status(400).json({ error: 'Se requiere jobId' });
    
    blacklist.set(jobId, Date.now());
    console.log(`[BLACKLIST] Agregado: ${jobId} (Total: ${blacklist.size})`);
    res.json({ success: true, jobId });
});

// ENDPOINT 2: "Dame un servidor fresco" (GET /api/next-server)
app.get('/api/next-server', async (req, res) => {
    const serverType = req.query.type || 'normal';
    const placeId = serverType === 'newplayers' ? CONFIG.NEW_PLAYERS_PLACE_ID : CONFIG.NORMAL_PLACE_ID;
    
    // 1. Obtener servidores REALES de Roblox
    const allServers = await getActiveServers(placeId);
    if (allServers.length === 0) {
        return res.status(500).json({ error: 'No se pudieron obtener servidores de Roblox' });
    }
    
    // 2. Filtrar blacklisted
    const availableServers = filterBlacklisted(allServers);
    console.log(`[API] Servidores: ${allServers.length} total, ${availableServers.length} disponibles tras filtro`);
    
    // 3. Elegir uno (el de menos jugadores para mayor estabilidad)
    let chosenServer;
    if (availableServers.length > 0) {
        // Prefiere servidores con pocos jugadores (más estables para teleport)
        availableServers.sort((a, b) => (a.playing || 0) - (b.playing || 0));
        chosenServer = availableServers[0];
    } else {
        // Si TODOS están blacklisted, elige el más antiguo en la lista
        const now = Date.now();
        let oldestTime = now;
        allServers.forEach(server => {
            const listTime = blacklist.get(server.id) || 0;
            if (listTime < oldestTime) {
                oldestTime = listTime;
                chosenServer = server;
            }
        });
        if (chosenServer) {
            console.log(`[API] ⚠️ Todos blacklisted. Eligiendo el más viejo: ${chosenServer.id}`);
        }
    }
    
    if (!chosenServer) {
        return res.status(404).json({ error: 'No hay servidores disponibles' });
    }
    
    // 4. Responder con el JobId REAL
    res.json({
        jobId: chosenServer.id,
        playerCount: chosenServer.playing,
        maxPlayers: chosenServer.maxPlayers,
        placeId: placeId,
        source: 'roblox-api'
    });
});

// Limpieza periódica de blacklist vieja
setInterval(() => {
    const now = Date.now();
    let removed = 0;
    for (let [jobId, time] of blacklist.entries()) {
        if (now - time > CONFIG.BLACKLIST_DURATION_MS * 2) { // Doble tiempo
            blacklist.delete(jobId);
            removed++;
        }
    }
    if (removed > 0) console.log(`[CLEANUP] Limpiados ${removed} entradas antiguas`);
}, 5 * 60 * 1000);

app.listen(CONFIG.PORT, () => {
    console.log(`✅ API funcionando. Blacklist: ${CONFIG.BLACKLIST_DURATION_MS/60000}min`);
    console.log(`🌐 Place IDs: Normal=${CONFIG.NORMAL_PLACE_ID}, NewPlayers=${CONFIG.NEW_PLAYERS_PLACE_ID}`);
});
