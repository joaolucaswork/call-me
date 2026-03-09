#!/usr/bin/env bun

/**
 * CallMe MCP Server
 *
 * A stdio-based MCP server that connects to the CallMe HTTP server.
 * Auto-starts the HTTP server if it's not already running.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn, type Subprocess } from 'bun';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const API_PORT = parseInt(process.env.CALLME_API_PORT || '3334', 10);
const API_BASE = `http://localhost:${API_PORT}/api`;

let httpServerProcess: Subprocess | null = null;
let sessionRegistered = false;

async function notifyConnect(): Promise<void> {
  try {
    await fetch(`${API_BASE}/connect`, { method: 'POST' });
    sessionRegistered = true;
  } catch {
    // Server might not support session tracking (older version)
  }
}

async function notifyDisconnect(): Promise<void> {
  if (!sessionRegistered) return;
  try {
    await fetch(`${API_BASE}/disconnect`, { method: 'POST' });
  } catch {
    // Best effort
  }
  sessionRegistered = false;
}

async function apiCall(endpoint: string, data: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((error as { error?: string }).error || 'API request failed');
  }

  return response.json();
}

async function checkServerHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/health`, { method: 'POST' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for an existing HTTP server to become healthy (another tab may be starting it).
 * Retries several times with 1s intervals before giving up.
 */
async function waitForExistingServer(attempts: number = 5): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await checkServerHealth()) {
      return true;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function startHttpServer(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const httpServerPath = resolve(__dirname, 'http-server.ts');

  console.error('Starting HTTP server...');
  let processExited = false;

  // Build public URL from ngrok domain if not already set
  const env = { ...process.env };
  if (!env.CALLME_PUBLIC_URL && env.CALLME_NGROK_DOMAIN) {
    env.CALLME_PUBLIC_URL = `https://${env.CALLME_NGROK_DOMAIN}`;
  }

  httpServerProcess = spawn({
    cmd: ['bun', 'run', httpServerPath],
    stdout: 'ignore',
    stderr: 'inherit',
    env,
  });

  // Monitor child process exit (e.g. EADDRINUSE → clean exit)
  httpServerProcess.exited.then(() => {
    processExited = true;
  });

  // Wait for the HTTP server to become healthy
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await checkServerHealth()) {
      console.error('HTTP server is ready');
      return;
    }
    // If our child exited (port taken), another server is running — wait for it
    if (processExited) {
      console.error('HTTP server process exited (port likely in use), waiting for existing server...');
      httpServerProcess = null;
      if (await waitForExistingServer(10)) {
        console.error('Connected to existing HTTP server');
        return;
      }
      throw new Error('HTTP server process exited and no existing server found');
    }
  }

  throw new Error('HTTP server failed to start within 30s');
}


async function main() {
  // Check if HTTP server is already running
  // Retry a few times first — another tab may be starting it right now
  if (await checkServerHealth()) {
    console.error('Connected to existing HTTP server');
  } else {
    console.error('HTTP server not found, waiting briefly for another instance...');
    const foundExisting = await waitForExistingServer(3);
    if (foundExisting) {
      console.error('Connected to existing HTTP server');
    } else {
      await startHttpServer();
    }
  }

  // Register this MCP session with the HTTP server
  await notifyConnect();

  // Create stdio MCP server
  const mcpServer = new Server(
    { name: 'callme', version: '3.0.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'initiate_call',
          description: 'Start a phone call with the user. Use when you need voice input, want to report completed work, or need real-time discussion. Always start with "Oi Lucas!" followed by a direct summary of what you need (e.g. "Oi Lucas! Terminei a task X, quer que eu explique?"). Also use this to CALL BACK IMMEDIATELY when any other tool returns hungUp: true — do not just inform, actually call again.',
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: 'What you want to say to the user. Be natural and conversational.',
              },
            },
            required: ['message'],
          },
        },
        {
          name: 'continue_call',
          description: 'Continue an active call with a follow-up message. IMPORTANT: If the response returns hungUp: true, you MUST immediately call initiate_call to call back — do not just report to chat that the user hung up.',
          inputSchema: {
            type: 'object',
            properties: {
              call_id: { type: 'string', description: 'The call ID from initiate_call' },
              message: { type: 'string', description: 'Your follow-up message' },
            },
            required: ['call_id', 'message'],
          },
        },
        {
          name: 'speak_to_user',
          description: 'Speak a message on an active call without waiting for a response. Use for status updates during long-running operations (e.g. "Estou rodando os testes, já volto") and in permanent call mode to keep the user informed without blocking execution. Ideal for acknowledging requests before starting time-consuming work.',
          inputSchema: {
            type: 'object',
            properties: {
              call_id: { type: 'string', description: 'The call ID from initiate_call' },
              message: { type: 'string', description: 'What to say to the user' },
            },
            required: ['call_id', 'message'],
          },
        },
        {
          name: 'end_call',
          description: 'End an active call with a closing message. Only call this when the user EXPLICITLY asks to end the call (e.g. "pode desligar", "finalizar"). Do NOT end the call on your own initiative — if in doubt, keep the call active. If the user already hung up, returns the conversation history.',
          inputSchema: {
            type: 'object',
            properties: {
              call_id: { type: 'string', description: 'The call ID from initiate_call' },
              message: { type: 'string', description: 'Your closing message (say goodbye!)' },
            },
            required: ['call_id', 'message'],
          },
        },
        {
          name: 'get_call_status',
          description: 'Check if a call is still active, hung up (with preserved context), or not found. Use this BEFORE speaking if you suspect the call may have dropped. If status is hung_up, IMMEDIATELY call initiate_call to reconnect — do not just report the status.',
          inputSchema: {
            type: 'object',
            properties: {
              call_id: { type: 'string', description: 'The call ID to check' },
            },
            required: ['call_id'],
          },
        },
        // WhatsApp tools
        {
          name: 'send_whatsapp',
          description: 'Send a WhatsApp message to the user. Supports text, images, audio, and documents. Use for async communication — status updates, sharing files, sending screenshots, etc. For text messages, just provide the message. For media, provide the URL.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'Text message to send (for text type)' },
              type: { type: 'string', enum: ['text', 'image', 'audio', 'document'], description: 'Message type. Default: text' },
              media_url: { type: 'string', description: 'URL of the media to send (for image/audio/document types)' },
              caption: { type: 'string', description: 'Caption for image or document' },
              filename: { type: 'string', description: 'Filename for document type' },
              to: { type: 'string', description: 'Phone number to send to. Default: user phone number from config' },
            },
            required: ['message'],
          },
        },
        {
          name: 'read_whatsapp',
          description: 'Read recent WhatsApp messages received from the user. Returns messages with text, transcribed audio, and media file paths. Audio messages are automatically transcribed. Image paths can be read with the Read tool to view them.',
          inputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'Max messages to return (default 20)' },
              since_timestamp: { type: 'number', description: 'Only return messages after this Unix timestamp (ms)' },
            },
          },
        },
      ],
    };
  });

  // Handle tool calls
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (request.params.name === 'initiate_call') {
        const { message } = request.params.arguments as { message: string };
        const result = await apiCall('/initiate_call', { message }) as { callId?: string; response?: string; hungUp?: boolean };

        if (result.hungUp) {
          return {
            content: [{ type: 'text', text: `HUNG UP — A ligação caiu (o usuário desligou antes de responder).\n\nACTION REQUIRED: You MUST immediately call initiate_call with message "Oi Lucas, a ligação caiu. Foi você que desligou?" to reconnect. Do NOT just report this to chat — actually call back NOW.` }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: `Call initiated successfully.\n\nCall ID: ${result.callId}\n\nUser's response:\n${result.response}\n\nUse continue_call to ask follow-ups or end_call to hang up.`,
          }],
        };
      }

      if (request.params.name === 'continue_call') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        const result = await apiCall('/continue_call', { call_id, message }) as { response?: string; hungUp?: boolean; conversationHistory?: Array<{ speaker: string; message: string }>; durationSeconds?: number };

        if (result.hungUp) {
          const history = result.conversationHistory?.map(h => `${h.speaker}: ${h.message}`).join('\n') || '(no history)';
          return {
            content: [{ type: 'text', text: `HUNG UP — A ligação caiu.\n\nConversation history:\n${history}\n\nACTION REQUIRED: You MUST immediately call initiate_call with message "Oi Lucas, a ligação caiu. Foi você que desligou?" to reconnect. Do NOT just report this to chat — actually call back NOW.` }],
          };
        }

        return {
          content: [{ type: 'text', text: `User's response:\n${result.response}` }],
        };
      }

      if (request.params.name === 'speak_to_user') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        const result = await apiCall('/speak_to_user', { call_id, message }) as { success?: boolean; hungUp?: boolean; conversationHistory?: Array<{ speaker: string; message: string }>; durationSeconds?: number };

        if (result.hungUp) {
          const history = result.conversationHistory?.map(h => `${h.speaker}: ${h.message}`).join('\n') || '(no history)';
          return {
            content: [{ type: 'text', text: `HUNG UP — A ligação caiu.\n\nConversation history:\n${history}\n\nACTION REQUIRED: You MUST immediately call initiate_call with message "Oi Lucas, a ligação caiu. Foi você que desligou?" to reconnect. Do NOT just report this to chat — actually call back NOW.` }],
          };
        }

        return {
          content: [{ type: 'text', text: `Message spoken: "${message}"` }],
        };
      }

      if (request.params.name === 'end_call') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        const result = await apiCall('/end_call', { call_id, message }) as { durationSeconds: number; conversationHistory?: Array<{ speaker: string; message: string }> };

        let text = `Call ended. Duration: ${result.durationSeconds}s`;
        if (result.conversationHistory) {
          const history = result.conversationHistory.map(h => `${h.speaker}: ${h.message}`).join('\n');
          text += `\n\nConversation history (user had already hung up):\n${history}`;
        }

        return {
          content: [{ type: 'text', text }],
        };
      }

      if (request.params.name === 'get_call_status') {
        const { call_id } = request.params.arguments as { call_id: string };
        const result = await apiCall('/get_call_status', { call_id }) as { status: string; conversationHistory?: Array<{ speaker: string; message: string }>; durationSeconds?: number };

        if (result.status === 'active') {
          return {
            content: [{ type: 'text', text: `Call is active (${result.durationSeconds}s). Use continue_call to speak or end_call to hang up.` }],
          };
        }

        if (result.status === 'hung_up') {
          const history = result.conversationHistory?.map(h => `${h.speaker}: ${h.message}`).join('\n') || '(no history)';
          return {
            content: [{ type: 'text', text: `HUNG UP — A ligação caiu (duration: ${result.durationSeconds}s).\n\nConversation history:\n${history}\n\nACTION REQUIRED: You MUST immediately call initiate_call with message "Oi Lucas, a ligação caiu. Foi você que desligou?" to reconnect. Do NOT just report this to chat — actually call back NOW.` }],
          };
        }

        return {
          content: [{ type: 'text', text: `Call not found: ${call_id}` }],
        };
      }

      if (request.params.name === 'send_whatsapp') {
        const args = request.params.arguments as {
          message: string;
          type?: string;
          media_url?: string;
          caption?: string;
          filename?: string;
          to?: string;
        };
        const to = args.to || ''; // Empty = use default from config
        const msgType = args.type || 'text';

        let result: any;
        switch (msgType) {
          case 'image':
            result = await apiCall('/whatsapp/send_image', { to, image_url: args.media_url, caption: args.caption || args.message });
            break;
          case 'audio':
            result = await apiCall('/whatsapp/send_audio', { to, audio_url: args.media_url });
            break;
          case 'document':
            result = await apiCall('/whatsapp/send_document', { to, document_url: args.media_url, filename: args.filename, caption: args.caption || args.message });
            break;
          default:
            result = await apiCall('/whatsapp/send_text', { to, message: args.message });
        }

        const r = result as { success: boolean; messageId?: string; error?: string };
        if (r.success) {
          return { content: [{ type: 'text', text: `WhatsApp message sent (${msgType}). ID: ${r.messageId}` }] };
        }
        return { content: [{ type: 'text', text: `Failed to send WhatsApp: ${r.error}` }], isError: true };
      }

      if (request.params.name === 'read_whatsapp') {
        const args = request.params.arguments as { limit?: number; since_timestamp?: number } || {};
        const result = await apiCall('/whatsapp/read_messages', {
          limit: args.limit || 20,
          since_timestamp: args.since_timestamp,
        }) as { messages: Array<any> };

        if (!result.messages || result.messages.length === 0) {
          return { content: [{ type: 'text', text: 'No WhatsApp messages received yet.' }] };
        }

        const formatted = result.messages.map((m: any) => {
          let line = `[${new Date(m.timestamp).toLocaleString('pt-BR')}] ${m.from} (${m.type})`;
          if (m.text) line += `: ${m.text}`;
          if (m.transcript) line += ` [transcribed: "${m.transcript}"]`;
          if (m.caption) line += ` [caption: "${m.caption}"]`;
          if (m.mediaLocalPath) line += ` [file: ${m.mediaLocalPath}]`;
          return line;
        }).join('\n');

        return { content: [{ type: 'text', text: `${result.messages.length} WhatsApp message(s):\n\n${formatted}` }] };
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const lowerMsg = errorMessage.toLowerCase();

      // User hung up — treat as hungUp response, not an error
      if (lowerMsg.includes('hung up') || lowerMsg.includes('call was hung up')) {
        return {
          content: [{ type: 'text', text: `HUNG UP — A ligação caiu (o usuário desligou antes de responder).\n\nACTION REQUIRED: You MUST immediately call initiate_call with message "Oi Lucas, a ligação caiu. Foi você que desligou?" to reconnect. Do NOT just report this to chat — actually call back NOW.` }],
        };
      }

      // Call already in progress — guide to use continue_call
      if (lowerMsg.includes('already in progress') || lowerMsg.includes('call already')) {
        return {
          content: [{ type: 'text', text: `A call is already active. Use continue_call with the active callId to keep talking, or end_call to hang up first.\n\nOriginal error: ${errorMessage}` }],
          isError: true,
        };
      }

      // Transient errors (timeout, WebSocket) — retry after short wait
      if (lowerMsg.includes('stt session') || lowerMsg.includes('timeout') || lowerMsg.includes('timed out') || lowerMsg.includes('websocket') || lowerMsg.includes('econnrefused') || lowerMsg.includes('econnreset')) {
        return {
          content: [{ type: 'text', text: `Transient error: ${errorMessage}\n\nACTION: Wait 2-3 seconds and retry the same tool call. This is usually a temporary issue that resolves on its own.` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  });

  // Connect MCP server via stdio
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error('CallMe MCP ready');

  // On exit, notify HTTP server that this session is gone
  const shutdown = async () => {
    await notifyDisconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => {
    // Sync best-effort disconnect (exit handler can't await)
    notifyDisconnect();
  });
}

main().catch(async (error) => {
  console.error('Fatal error:', error);
  await notifyDisconnect();
  process.exit(1);
});
