// blossom aj
const express = require('express');
const app = express();
app.use(express.json());

// memory
let blacklist = {}; 
const TTL = 10 * 60 * 1000; // 10 MINUTOS EXACTOS (Cambiable aquí)

// blakclist
app.post('/burn', (req, res) => {
    const { jobId } = req.body;
    blacklist[jobId] = Date.now();
    console.log(`[-] Sector marcado como quemado por 10min: ${jobId}`);
    res.send("OK");
});

// prohibited servers
app.get('/list', (req, res) => {
    const now = Date.now();
    // Limpieza automática
    for (let id in blacklist) {
        if (now - blacklist[id] > TTL) delete blacklist[id];
    }
    res.json(Object.keys(blacklist));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("blossom api 🟢"));
