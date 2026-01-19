const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const app = express();
app.use(express.json());

// CONFIGURACIÓN (AJUSTA AQUÍ)
const CONFIG = {
    NORMAL_PLACE_ID: '109983668079237',
    NEW_PLAYERS_PLACE_ID: '96342491571673',
    BLACKLIST_DURATION_MS: 15 * 60 * 1000, // 15 minutos en milisegundos (¡AJUSTABLE!)
    PORT: process.env.PORT || 3000
};

// memory
let serverBlacklist = new Map(); // JobId -> timestamp de visita

// Función para obtener servidores de la API de Roblox (pública, limitada)
async function fetchServers(placeId) {
    const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Desc&limit=100`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        return data.data || [];
    } catch (error) {
        console.error(`Error fetching servers for ${placeId}:`, error);
        return [];
    }
}

// Lógica principal: Filtra servidores blacklisted y elige uno.
function selectTargetServer(servers, blacklist, durationMs) {
    const now = Date.now();
    const availableServers = servers.filter(server => {
        const blacklistTime = blacklist.get(server.id);
        if (!blacklistTime) return true; // Nunca visitado
        return (now - blacklistTime) > durationMs; // Visitado, pero ya pasó el tiempo
    });

    if (availableServers.length > 0) {
        // Elige uno al azar de los disponibles para distribución.
        return availableServers[Math.floor(Math.random() * availableServers.length)];
    } else {
        // Si todos están en blacklist, elige el más antiguo (el que lleva más tiempo en la lista).
        let oldestServer = null;
        let oldestTime = now;
        for (const server of servers) {
            const blacklistTime = blacklist.get(server.id);
            if (blacklistTime < oldestTime) {
                oldestTime = blacklistTime;
                oldestServer = server;
            }
        }
        return oldestServer; // Puede ser null si no hay servidores
    }
}

// ENDPOINT 1: "Dame un servidor al que saltar"
app.get('/api/next-server', async (req, res) => {
    const serverType = req.query.type || 'normal'; // 'normal' o 'newplayers'
    const placeId = serverType === 'newplayers' ? CONFIG.NEW_PLAYERS_PLACE_ID : CONFIG.NORMAL_PLACE_ID;

    const servers = await fetchServers(placeId);
    if (servers.length === 0) {
        return res.status(500).json({ error: 'No se pudieron obtener servidores.' });
    }

    const targetServer = selectTargetServer(servers, serverBlacklist, CONFIG.BLACKLIST_DURATION_MS);
    if (!targetServer) {
        return res.status(404).json({ error: 'No hay servidores disponibles tras aplicar el filtro.' });
    }

    res.json({
        placeId: placeId,
        jobId: targetServer.id,
        playerCount: targetServer.playing,
        maxPlayers: targetServer.maxPlayers,
        // ¡Enviar el tiempo actual para que el cliente sepa cuándo fue seleccionado!
        selectedAt: Date.now()
    });
});

// ENDPOINT 2: "Acabo de llegar a este servidor, blacklistéalo"
app.post('/api/visited', (req, res) => {
    const { jobId } = req.body;
    if (!jobId) {
        return res.status(400).json({ error: 'Se requiere jobId.' });
    }
    // Añade a la blacklist con el timestamp ACTUAL.
    serverBlacklist.set(jobId, Date.now());
    console.log(`[BLACKLIST] Agregado ${jobId}. Tamaño actual: ${serverBlacklist.size}`);
    // Limpieza opcional de entradas muy viejas (más de 24h) para no llenar la memoria.
    // ...
    res.json({ success: true, jobId, timestamp: serverBlacklist.get(jobId) });
});

app.listen(CONFIG.PORT, () => {
    console.log(`server hop ${CONFIG.PORT}`);
    console.log(`blacklist duration: ${CONFIG.BLACKLIST_DURATION_MS / 60000} minutos`);
});
