"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = require("http");
const storage_1 = require("@google-cloud/storage");
const storage = new storage_1.Storage();
const bucket = storage.bucket('lein-wol');
const stateFile = bucket.file('state.txt');
const SECRET = process.env.WAKE_SECRET || '';
const PORT = parseInt(process.env.PORT || '8080');
const server = (0, http_1.createServer)(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    if (req.method === 'POST' && url.pathname === '/wake') {
        const secret = req.headers['x-wake-secret'] || url.searchParams.get('secret');
        if (SECRET && secret !== SECRET) {
            res.writeHead(401);
            res.end('unauthorized');
            return;
        }
        try {
            await stateFile.save('wake', { contentType: 'text/plain', resumable: false });
            console.log('Wake command written to GCS');
            res.writeHead(200);
            res.end('wake command queued');
        }
        catch (err) {
            console.error('GCS write error:', err.message);
            res.writeHead(500);
            res.end('error writing to GCS');
        }
        return;
    }
    if (req.method === 'POST' && url.pathname === '/idle') {
        try {
            await stateFile.save('idle', { contentType: 'text/plain', resumable: false });
            res.writeHead(200);
            res.end('ok');
        }
        catch (err) {
            res.writeHead(500);
            res.end('error');
        }
        return;
    }
    res.writeHead(200);
    res.end('lein-wol service');
});
server.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});
