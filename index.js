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

// ENDPOINT 2: "Dame un servidor fresco" (GET /api/next-server) - VERSIÓN DIAGNÓSTICO
app.get('/api/next-server', async (req, res) => {
    const serverType = req.query.type || 'normal';
    const placeId = serverType === 'newplayers' ? CONFIG.NEW_PLAYERS_PLACE_ID : CONFIG.NORMAL_PLACE_ID;
    
    // 1. Obtener servidores REALES
    const allServers = await getActiveServers(placeId);
    console.log(`[API] [1/4] ✅ Obtenidos ${allServers.length} servidores de Roblox.`);
    
    // 2. Mostrar estado ACTUAL de la blacklist (DEBUG)
    console.log(`[API] [2/4] 📋 Estado BLACKLIST: Tamaño = ${blacklist.size}`);
    if (blacklist.size > 0) {
        const now = Date.now();
        console.log("       Contenido (JobId -> Tiempo restante en minutos):");
        blacklist.forEach((timestamp, jobId) => {
            const timeLeftMin = ((CONFIG.BLACKLIST_DURATION_MS - (now - timestamp)) / 60000).toFixed(1);
            if (timeLeftMin > 0) {
                console.log(`       - ${jobId}: ${timeLeftMin} min restantes`);
            }
        });
    }
    
    // 3. Filtrar blacklisted
    const availableServers = filterBlacklisted(allServers);
    console.log(`[API] [3/4] 🎯 POST-FILTRO: ${availableServers.length} servidores disponibles.`);
    
    // 4. Elegir uno ALEATORIO (no el primero)
    let chosenServer;
    if (availableServers.length > 0) {
        const randomIndex = Math.floor(Math.random() * availableServers.length);
        chosenServer = availableServers[randomIndex];
        console.log(`[API] [4/4] 🎲 Elegido ALEATORIAMENTE: ${chosenServer.id} (índice ${randomIndex})`);
    } else {
        // Fallback: si todos están blacklisted, elige uno cualquiera
        chosenServer = allServers[Math.floor(Math.random() * allServers.length)];
        console.log(`[API] [4/4] ⚠️ TODOS blacklisted. Fallback: ${chosenServer.id}`);
    }
    
    // 5. Responder
    res.json({
        jobId: chosenServer.id,
        playerCount: chosenServer.playing,
        maxPlayers: chosenServer.maxPlayers,
        placeId: placeId,
        debug: {
            totalServers: allServers.length,
            availableAfterFilter: availableServers.length,
            selectionMethod: availableServers.length > 0 ? "random" : "fallback"
        }
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

// Endpoint de depuración - Agrega esto ANTES de app.listen()
app.get('/api/debug', (req, res) => {
    const now = Date.now();
    const activeBlacklist = [];
    
    blacklist.forEach((timestamp, jobId) => {
        const timeLeft = CONFIG.BLACKLIST_DURATION_MS - (now - timestamp);
        if (timeLeft > 0) {
            activeBlacklist.push({
                jobId: jobId,
                expiresInMinutes: (timeLeft / 60000).toFixed(1)
            });
        }
    });
    
    res.json({
        status: 'online',
        blacklistSize: blacklist.size,
        activeBlacklist: activeBlacklist,
        memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024 + ' MB'
    });
});

app.listen(CONFIG.PORT, () => {
    console.log(`✅ API funcionando. Blacklist: ${CONFIG.BLACKLIST_DURATION_MS/60000}min`);
    console.log(`🌐 Place IDs: Normal=${CONFIG.NORMAL_PLACE_ID}, NewPlayers=${CONFIG.NEW_PLAYERS_PLACE_ID}`);
});
