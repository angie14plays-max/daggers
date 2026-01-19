const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

let blacklist = new Map();

// Función nativa para no depender de librerías externas
function generateId() { return Math.random().toString(36).substring(2, 15); }

app.get('/', (req, res) => res.send("Cerebro de David: DESPIERTO 🟢"));

app.post('/api/blacklist', (req, res) => {
    const { robloxJobId, placeType } = req.body;
    const minutes = 12;
    const expiry = Date.now() + (minutes * 60 * 1000);
    blacklist.set(robloxJobId, expiry);
    console.log(`[-] Bloqueado: ${robloxJobId} por ${minutes}min`);
    res.json({ success: true, id: generateId() });
});

app.get('/api/next-server', async (req, res) => {
    const type = req.query.type || 'normal';
    const placeId = (type === 'newplayers') ? 96342491571673 : 109983668079237;
    const now = Date.now();

    try {
        // Limpiar blacklist expirada
        for (let [id, time] of blacklist) { if (now > time) blacklist.delete(id); }

        const r = await axios.get(`https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=100`);
        const servers = r.data.data;

        const fresh = servers.filter(s => !blacklist.has(s.id) && s.playing < s.maxPlayers && s.id !== req.query.current);

        if (fresh.length > 0) {
            const target = fresh[Math.floor(Math.random() * fresh.length)];
            res.json({ jobId: target.id });
        } else {
            res.json({ jobId: servers[0].id, note: "Reset" });
        }
    } catch (e) { res.status(500).json({ error: "Roblox Down" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Legion API en puerto ${PORT}`));
