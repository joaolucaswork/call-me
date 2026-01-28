# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CallMe is a Claude Code plugin (MCP server) that lets Claude call users on the phone. It runs locally and uses ngrok to expose webhooks for phone providers.

**Stack**: TypeScript, Bun runtime, MCP protocol

## Commands

```bash
cd server
bun install          # Install dependencies
bun run start        # Start MCP server (production)
bun run dev          # Start with file watching (development)
```

No test or lint setup exists.

## Architecture

```
Claude Code → stdio → MCP Server (index.ts)
                           │
                           ├── CallManager (phone-call.ts)
                           │   ├── Phone Provider (Telnyx/Twilio)
                           │   ├── TTS Provider (OpenAI)
                           │   └── STT Provider (OpenAI Realtime)
                           │
                           ├── ngrok tunnel (ngrok.ts)
                           │
                           └── HTTP/WebSocket Server (webhooks + media streams)
```

### Key Components

- **server/src/index.ts**: MCP server entry point, registers 4 tools: `initiate_call`, `continue_call`, `speak_to_user`, `end_call`
- **server/src/phone-call.ts**: Core call management - handles call lifecycle, audio encoding (24kHz PCM → 8kHz mu-law), jitter buffer, WebSocket media streams
- **server/src/providers/**: Pluggable provider system
  - `phone-telnyx.ts` / `phone-twilio.ts`: Phone providers
  - `tts-openai.ts`: Text-to-speech
  - `stt-openai-realtime.ts`: Real-time speech-to-text with VAD
- **server/src/ngrok.ts**: Tunnel management with auto-reconnect
- **server/src/webhook-security.ts**: Signature verification (Twilio HMAC-SHA1, Telnyx Ed25519)

### Audio Flow

User speaks → Phone Provider WebSocket (mu-law 8kHz) → `extractInboundAudio()` → STT session → OpenAI Realtime API → transcript returned to Claude

Outbound: OpenAI TTS (24kHz PCM) → `resample24kTo8k()` (linear interpolation) → mu-law encode → WebSocket → Phone Provider

## Plugin Configuration

- **.claude-plugin/plugin.json**: Plugin manifest with MCP server config and Stop hook
- **skills/phone-input/SKILL.md**: Skill definition that teaches Claude when/how to use phone tools

The Stop hook silently evaluates whether to call the user after each task completion - only calls for significant work or when blocked.

## Environment Variables

Required: `CALLME_PHONE_PROVIDER`, `CALLME_PHONE_ACCOUNT_SID`, `CALLME_PHONE_AUTH_TOKEN`, `CALLME_PHONE_NUMBER`, `CALLME_USER_PHONE_NUMBER`, `CALLME_OPENAI_API_KEY`, `CALLME_NGROK_AUTHTOKEN`

See `.env.example` for full list with descriptions.
