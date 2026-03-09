import { createServer } from 'http';
import { Storage } from '@google-cloud/storage';

const storage = new Storage();
const bucket = storage.bucket('lein-wol');
const stateFile = bucket.file('state.txt');

const SECRET = process.env.WAKE_SECRET || '';
const PORT = parseInt(process.env.PORT || '8080');

const server = createServer(async (req, res) => {
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
    } catch (err: any) {
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
    } catch (err: any) {
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
