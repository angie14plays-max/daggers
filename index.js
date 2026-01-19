const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// Memoria volátil: { "JobId": TiempoDeExpiracion }
let globalBlacklist = {};

app.get('/', (req, res) => res.send("NEXO DE DAVID: ONLINE 🟢"));

// RUTA ÚNICA PARA MARCAR Y SALTAR
app.get('/api/hop', async (req, res) => {
    const { type, current, mins } = req.query;
    const placeId = (type === 'newbie') ? 96342491571673 : 109983668079237;
    const blacklistTime = parseInt(mins) || 12; // Minutos ajustables por URL
    
    const now = Date.now();

    // 1. Blacklistear el servidor actual si se envió
    if (current && current !== "null") {
        globalBlacklist[current] = now + (blacklistTime * 60 * 1000);
        console.log(`[!] Quemando server ${current} por ${blacklistTime}m`);
    }

    // 2. Limpiar blacklist vieja
    for (let id in globalBlacklist) {
        if (now > globalBlacklist[id]) delete globalBlacklist[id];
    }

    try {
        // 3. Buscar servidores en Roblox (Salto global con cursor aleatorio)
        let cursor = "";
        const pageSkip = Math.floor(Math.random() * 4);
        for(let i = 0; i < pageSkip; i++) {
            const r = await axios.get(`https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=100&cursor=${cursor}`);
            cursor = r.data.nextPageCursor;
            if(!cursor) break;
        }

        const response = await axios.get(`https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=100&cursor=${cursor}`);
        const servers = response.data.data;

        // 4. Filtrar los que no hemos visto
        const candidates = servers.filter(s => !globalBlacklist[s.id] && s.playing < s.maxPlayers && s.id !== current);

        if (candidates.length > 0) {
            const target = candidates[Math.floor(Math.random() * candidates.length)];
            res.json({ jobId: target.id });
        } else {
            res.json({ jobId: servers[0].id, note: "Página saturada, rotando..." });
        }
    } catch (e) {
        res.status(500).json({ error: "Roblox API Fail" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
