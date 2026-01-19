// api ag
const express = require('express');
const app = express();
app.use(express.json());

// memory: { "JobId": ExpireTimestamp }
let blacklist = {};
const TTL = 10 * 60 * 1000; // 10 min

// 1. burned id
app.post('/burn', (req, res) => {
    const { jobId } = req.body;
    blacklist[jobId] = Date.now();
    console.log(`[-] Sector marcado como quemado: ${jobId}`);
    res.send("OK");
});

// 2. list
app.get('/list', (req, res) => {
    const now = Date.now();
    // Limpieza automática antes de entregar
    for (let id in blacklist) {
        if (now - blacklist[id] > TTL) delete blacklist[id];
    }
    res.json(Object.keys(blacklist));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("blossom api working 🟢"));
