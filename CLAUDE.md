# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Lein is a personal AI assistant (OpenClaw-style) that runs locally as a Claude Code plugin. She communicates via phone calls and WhatsApp, spawns multiple Claude Code sessions in ~/lein-workspace/, and maintains persistent memory across sessions.

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
Lein Server (PM2 daemon)
├── HTTP Server (webhooks + API)
│   ├── Phone webhooks (Twilio/Telnyx)
│   ├── WhatsApp webhooks (Kapso)
│   └── API bridge (for MCP tools)
├── Claude Spawner (multi-session)
│   ├── Spawns in ~/lein-workspace/
│   ├── Injects MEMORY.md + project list
│   └── Multiple simultaneous sessions
├── CallManager (phone-call.ts)
│   ├── Phone Provider (Telnyx/Twilio)
│   ├── TTS Provider (OpenAI)
│   └── STT Provider (OpenAI Realtime)
├── ngrok tunnel (ngrok.ts)
└── Workspace (~/lein-workspace/)
    ├── MEMORY.md (persistent memory)
    ├── memory/ (topic files)
    ├── sessions/ (active session tracking)
    └── .media/ (downloaded media)
```

### Key Components

- **server/src/index.ts**: MCP server entry point, registers 7 tools (phone + WhatsApp)
- **server/src/phone-call.ts**: Core call management - handles call lifecycle, audio encoding, WebSocket media streams
- **server/src/claude-spawner.ts**: Multi-session spawner - spawns Claude CLI in ~/lein-workspace/ with memory and project context
- **server/src/workspace.ts**: Workspace directory management and memory access
- **server/src/whatsapp.ts**: WhatsApp via Kapso - message send/receive, media download, audio transcription
- **server/src/providers/**: Pluggable provider system
  - `phone-telnyx.ts` / `phone-twilio.ts`: Phone providers
  - `tts-openai.ts`: Text-to-speech
  - `stt-openai-realtime.ts`: Real-time speech-to-text with VAD
- **server/src/ngrok.ts**: Tunnel management with auto-reconnect
- **server/src/webhook-security.ts**: Signature verification (Twilio HMAC-SHA1, Telnyx Ed25519)

### Audio Flow

User speaks -> Phone Provider WebSocket (mu-law 8kHz) -> `extractInboundAudio()` -> STT session -> OpenAI Realtime API -> transcript returned to Claude

Outbound: OpenAI TTS (24kHz PCM) -> `resample24kTo8k()` (linear interpolation) -> mu-law encode -> WebSocket -> Phone Provider

## Plugin Configuration

- **.claude-plugin/plugin.json**: Plugin manifest with MCP server config and hooks
- **skills/phone-input/SKILL.md**: Skill definition that teaches Claude when/how to use phone tools

The Stop hook silently evaluates whether to call the user after each task completion.

## Environment Variables

Required: `LEIN_PHONE_PROVIDER`, `LEIN_PHONE_ACCOUNT_SID`, `LEIN_PHONE_AUTH_TOKEN`, `LEIN_PHONE_NUMBER`, `LEIN_USER_PHONE_NUMBER`, `LEIN_OPENAI_API_KEY`, `LEIN_NGROK_AUTHTOKEN`

See `.env.example` for full list with descriptions.
