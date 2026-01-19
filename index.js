// index.js - BACKEND CON UUID SYSTEM
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const app = express();

app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

const CONFIG = {
    PORT: process.env.PORT || 3000,
    BLACKLIST_MINUTES: 10,
    PLACES: {
        NORMAL: { id: '109983668079237', type: 'normal' },
        NEW_PLAYERS: { id: '96342491571673', type: 'newplayers' }
    }
};

// Almacenamiento con UUID
const serverDatabase = new Map(); // UUID -> { robloxJobId, placeType, firstSeen, visits }
const blacklist = new Map();      // UUID -> expiryTime

// ==================== ENDPOINTS ====================

// 1. REGISTRAR SERVIDOR Y OBTENER UUID
app.post('/api/register', (req, res) => {
    const { robloxJobId, placeType } = req.body;
    
    // Buscar si ya existe
    let existingUUID = null;
    for (const [uuid, data] of serverDatabase.entries()) {
        if (data.robloxJobId === robloxJobId && data.placeType === placeType) {
            existingUUID = uuid;
            data.visits++;
            data.lastSeen = Date.now();
            break;
        }
    }
    
    const uuid = existingUUID || uuidv4();
    
    if (!existingUUID) {
        serverDatabase.set(uuid, {
            robloxJobId,
            placeType,
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            visits: 1
        });
    }
    
    res.json({ uuid, isNew: !existingUUID, robloxJobId });
});

// 2. BLACKLIST POR UUID
app.post('/api/blacklist', (req, res) => {
    const { uuid } = req.body;
    
    if (!serverDatabase.has(uuid)) {
        return res.status(404).json({ error: 'UUID no encontrado' });
    }
    
    const expiry = Date.now() + (CONFIG.BLACKLIST_MINUTES * 60 * 1000);
    blacklist.set(uuid, expiry);
    
    const server = serverDatabase.get(uuid);
    console.log(`[BLACKLIST] ${uuid} -> ${server.robloxJobId} (${server.placeType})`);
    
    res.json({ success: true, uuid, expiresAt: expiry });
});

// 3. OBTENER SERVIDOR FRESCO (CON UUID)
app.get('/api/next-server', async (req, res) => {
    const placeType = req.query.type || 'normal';
    const placeId = placeType === 'newplayers' 
        ? CONFIG.PLACES.NEW_PLAYERS.id 
        : CONFIG.PLACES.NORMAL.id;
    
    try {
        // Obtener de Roblox
        const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=100`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (!data.data) return res.status(500).json({ error: 'Roblox API error' });
        
        const now = Date.now();
        const candidates = [];
        
        // Para cada servidor de Roblox
        for (const robloxServer of data.data) {
            // Buscar si ya tiene UUID en nuestra DB
            let uuid = null;
            for (const [existingUuid, serverData] of serverDatabase.entries()) {
                if (serverData.robloxJobId === robloxServer.id && 
                    serverData.placeType === placeType) {
                    uuid = existingUuid;
                    break;
                }
            }
            
            // Si no tiene UUID, es candidato (nuevo para nosotros)
            const isNewToUs = !uuid;
            
            // Si tiene UUID, verificar si no está blacklisted
            const isBlacklisted = uuid && blacklist.has(uuid) && blacklist.get(uuid) > now;
            
            if (isNewToUs || !isBlacklisted) {
                candidates.push({
                    robloxJobId: robloxServer.id,
                    uuid: uuid,
                    isNewToUs,
                    playerCount: robloxServer.playing,
                    maxPlayers: robloxServer.maxPlayers
                });
            }
        }
        
        // Elegir el mejor candidato (priorizar nuevos)
        const newCandidates = candidates.filter(c => c.isNewToUs);
        const target = (newCandidates.length > 0)
            ? newCandidates[Math.floor(Math.random() * newCandidates.length)]
            : candidates[Math.floor(Math.random() * candidates.length)];
        
        // Si es nuevo, crear registro ahora
        if (target.isNewToUs) {
            const newUuid = uuidv4();
            serverDatabase.set(newUuid, {
                robloxJobId: target.robloxJobId,
                placeType,
                firstSeen: now,
                lastSeen: now,
                visits: 0
            });
            target.uuid = newUuid;
        }
        
        res.json({
            jobId: target.robloxJobId,
            uuid: target.uuid,
            playerCount: target.playerCount,
            maxPlayers: target.maxPlayers,
            placeType,
            candidatesCount: candidates.length,
            totalFromRoblox: data.data.length
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. ESTADO DEL SISTEMA
app.get('/api/stats', (req, res) => {
    const stats = {
        totalServers: serverDatabase.size,
        blacklisted: Array.from(blacklist.entries()).filter(([_, expiry]) => expiry > Date.now()).length,
        byPlaceType: {
            normal: 0,
            newplayers: 0
        }
    };
    
    serverDatabase.forEach(server => {
        stats.byPlaceType[server.placeType]++;
    });
    
    res.json(stats);
});

app.listen(CONFIG.PORT, () => {
    console.log(`✅ UUID Blacklist API en puerto ${CONFIG.PORT}`);
});
