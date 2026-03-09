# Lein - OpenClaw-style Personal AI Assistant

**Date**: 2026-03-09
**Status**: Approved
**Rebrand**: CallMe -> Lein (feminine persona)

## Overview

Lein is a 24/7 personal AI assistant (OpenClaw-style) that runs locally. She receives messages via WhatsApp and phone calls, spawns Claude Code sessions to execute tasks, and maintains persistent memory across sessions.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Working directory | `~/lein-workspace/` (neutral) | Claude decides which project to open based on message content |
| Sessions | Multiple simultaneous | Each message can spawn a new Claude session |
| Memory | Global `MEMORY.md` | Single persistent memory accessible by all sessions |
| Rebrand | Complete (env vars, plugin, dirs) | `LEIN_` prefix, new identity |
| Persona | Feminine ("a Lein") | All messaging uses feminine pronouns |

## Architecture

```
Lein Server (PM2 daemon)
├── HTTP Server (webhooks + API)
│   ├── Phone webhooks (Twilio/Telnyx)
│   ├── WhatsApp webhooks (Kapso)
│   └── API bridge (for MCP tools)
├── Session Manager (multi-session)
│   ├── Track active sessions by ID
│   ├── Map sessions to channels (whatsapp/phone)
│   └── Cleanup completed/stale sessions
├── Claude Spawner (multi-spawn)
│   ├── Spawn in ~/lein-workspace/
│   ├── Include MEMORY.md in prompt
│   ├── Include project list in prompt
│   └── No single-spawn lock
├── Memory Manager
│   ├── ~/lein-workspace/MEMORY.md
│   └── ~/lein-workspace/memory/ (topic files)
├── WhatsApp Handler (Kapso)
│   └── Message history + media download
└── Phone Handler (Twilio)
    └── Call lifecycle + audio streaming
```

## Directory Structure

```
~/lein-workspace/
├── MEMORY.md              # Global persistent memory
├── memory/                # Topic-specific notes
├── sessions/              # Active session tracking
│   └── {session-id}.json  # Session state files
└── .media/                # Downloaded media files
```

## Session Lifecycle

1. Inbound message arrives (WhatsApp or phone)
2. Lein server registers the message
3. New session created: `sessions/{uuid}.json`
4. Claude Code CLI spawned in `~/lein-workspace/`
5. Prompt includes:
   - User's message
   - MEMORY.md contents
   - List of available projects (`~/Documents/GitHub/*`)
   - Session ID for tracking
6. Claude processes the task (may navigate to a project)
7. Session marked complete on exit
8. Memory updated if relevant

## Rebrand Scope

### Environment Variables
- `CALLME_*` -> `LEIN_*`
- `LEIN_PHONE_PROVIDER`, `LEIN_PHONE_ACCOUNT_SID`, etc.

### Plugin
- Plugin name: `lein`
- MCP server name: `lein`

### Directories
- `server/.whatsapp-sessions/` -> `~/lein-workspace/sessions/`
- `server/.media/` -> `~/lein-workspace/.media/`
- `/tmp/callme-sessions/` -> `~/lein-workspace/sessions/`

### Code
- All `CALLME_` references -> `LEIN_`
- Persona in greetings/messages: feminine ("Oi, eu sou a Lein")
- Project references: "Lein" instead of "CallMe"

## Multi-Session Support

- Remove `activeSpawn` singleton lock from `claude-spawner.ts`
- Track sessions in `Map<string, SessionInfo>` instead
- Each session gets unique ID
- Sessions can run in parallel without blocking
- Cleanup: sessions older than 2 hours auto-removed

## Memory System

- `~/lein-workspace/MEMORY.md` loaded into every spawned session's prompt
- Sessions can update MEMORY.md via file operations
- Format follows Claude Code's auto-memory pattern
- Topic files in `memory/` for detailed notes
