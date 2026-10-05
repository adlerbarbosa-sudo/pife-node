'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Store } = require('./src/store');
const { createHub } = require('./src/hub');

const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
].join('; ');

function createApp({ dataDir } = {}) {
    const app = express();
    app.disable('x-powered-by');
    const server = http.createServer(app);
    const io = new Server(server, { maxHttpBufferSize: 1e5, pingInterval: 10000, pingTimeout: 15000 });

    const store = new Store(dataDir);
    const hub = createHub({ io, store });
    io.on('connection', (socket) => hub.onConnection(socket));

    app.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', CSP);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'same-origin');
        next();
    });
    app.get('/healthz', (req, res) => res.json({ ok: true, rooms: hub.rooms.size }));
    app.use(express.static(path.join(__dirname, 'public'), {
        setHeaders(res, file) {
            // HTML/JS/CSS sempre revalidados, para os jogadores nunca ficarem presos numa versão antiga
            if (/\.(html|js|css|json)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
        },
    }));

    return { app, server, io, store, hub };
}

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
    const { server, store, hub } = createApp({ dataDir });
    hub.startSweeper();
    server.listen(PORT, () => console.log(`Clube do Pife rodando na porta ${PORT} (contas em ${dataDir})`));

    const stop = () => { hub.shutdown(); store.flushSync(); process.exit(0); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

module.exports = { createApp };
