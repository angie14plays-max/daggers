// [[ DAVID'S PHANTOM LIBRARY v5.0 ]]
const express = require('express');
const app = express();
app.use(express.json());

let blacklists = { normal: {}, newbie: {} };
let ttlMinutes = 15; // Ajustable aquí

// Ruta para marcar como visto
app.post('/mark', (req, res) => {
    const { type, jobId } = req.body;
    if (!blacklists[type]) return res.sendStatus(400);
    blacklists[type][jobId] = Date.now();
    res.send("OK");
});

// Ruta para obtener toda la lista negra
app.get('/list', (req, res) => {
    const { type } = req.query;
    const now = Date.now();
    const ttl = ttlMinutes * 60 * 1000;
    
    // Limpieza
    for (let id in blacklists[type]) {
        if (now - blacklists[type][id] > ttl) delete blacklists[type][id];
    }
    res.json(Object.keys(blacklists[type]));
});

app.listen(process.env.PORT || 3000, () => console.log("LIBRERO ACTIVO 🟢"));
