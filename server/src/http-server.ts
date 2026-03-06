#!/usr/bin/env bun

/**
 * CallMe HTTP Server (standalone)
 *
 * Runs the HTTP server + ngrok independently of the MCP.
 * This allows PM2 to keep the server running while Claude connects via MCP.
 */

import { CallManager, loadServerConfig } from './phone-call.js';
import { startNgrok, stopNgrok } from './ngrok.js';
import { createServer } from 'http';

// Store call manager globally for API access
let callManager: CallManager | null = null;

// Track connected MCP sessions
let connectedSessions = 0;

async function main() {
  const port = parseInt(process.env.CALLME_PORT || '3333', 10);
  const apiPort = parseInt(process.env.CALLME_API_PORT || '3334', 10);

  // Use CALLME_PUBLIC_URL if set (external ngrok or other tunnel), otherwise start ngrok
  let publicUrl: string;
  let usingExternalTunnel = false;

  if (process.env.CALLME_PUBLIC_URL) {
    publicUrl = process.env.CALLME_PUBLIC_URL.replace(/\/$/, ''); // Remove trailing slash
    usingExternalTunnel = true;
    console.error(`Using external tunnel: ${publicUrl}`);
  } else {
    console.error('Starting ngrok tunnel...');
    try {
      publicUrl = await startNgrok(port);
      console.error(`ngrok tunnel: ${publicUrl}`);
    } catch (error) {
      console.error('Failed to start ngrok:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }

  // Load config and start call manager
  let serverConfig;
  try {
    serverConfig = loadServerConfig(publicUrl);
  } catch (error) {
    console.error('Configuration error:', error instanceof Error ? error.message : error);
    await stopNgrok();
    process.exit(1);
  }

  callManager = new CallManager(serverConfig);

  // Set up inbound call notification handler
  callManager.setInboundCallHandler((callId, from, transcript) => {
    console.error(`[Inbound] Call ${callId} from ${from}: "${transcript}"`);
    console.error('[Inbound] Pending call info written — hooks will notify Claude');
  });

  callManager.startServer();

  // Start API server for MCP communication
  const apiServer = createServer(async (req, res) => {
    // CORS headers for local requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url!, `http://localhost:${apiPort}`);

    // Health check doesn't need POST or body
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', publicUrl, connectedSessions }));
      return;
    }

    // Session tracking endpoints
    if (url.pathname === '/api/connect') {
      connectedSessions++;
      console.error(`MCP session connected (${connectedSessions} active)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: connectedSessions }));
      return;
    }

    if (url.pathname === '/api/disconnect') {
      connectedSessions = Math.max(0, connectedSessions - 1);
      console.error(`MCP session disconnected (${connectedSessions} active)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: connectedSessions }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }

    // Parse JSON body
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);

        let result: unknown;

        switch (url.pathname) {
          case '/api/initiate_call':
            result = await callManager!.initiateCall(data.message);
            break;
          case '/api/continue_call': {
            const continueResult = await callManager!.continueCall(data.call_id, data.message);
            // If hung up, returns object with context; otherwise returns string response
            result = typeof continueResult === 'string' ? { response: continueResult } : continueResult;
            break;
          }
          case '/api/speak_to_user': {
            const speakResult = await callManager!.speakOnly(data.call_id, data.message);
            // If hung up, returns object with context; otherwise returns void
            result = speakResult || { success: true };
            break;
          }
          case '/api/end_call':
            result = await callManager!.endCall(data.call_id, data.message);
            break;
          case '/api/get_call_status':
            result = callManager!.getCallStatus(data.call_id);
            break;
          default:
            res.writeHead(404);
            res.end('Not found');
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    });
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.error('\nShutting down...');
    callManager?.shutdown();
    apiServer.close();
    if (!usingExternalTunnel) {
      await stopNgrok();
    }
    process.exit(0);
  };

  // Handle port binding errors (e.g. another HTTP server already running)
  apiServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`API port ${apiPort} already in use - another server is running`);
      process.exit(0); // Clean exit so parent MCP process connects to existing server
    }
    console.error('API server error:', err);
    process.exit(1);
  });

  apiServer.listen(apiPort, () => {
    console.error(`API server listening on port ${apiPort}`);
    console.error('');
    console.error('CallMe HTTP Server ready');
    console.error(`Phone: ${serverConfig.phoneNumber} -> ${serverConfig.userPhoneNumber}`);
    console.error(`Webhook: ${publicUrl}/twiml`);
    console.error(`API: http://localhost:${apiPort}/api/*`);
    console.error('');
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
