# Sentinel Hybrid Design

## Problem

Each WhatsApp message spawns a new `claude -p --dangerously-skip-permissions` process, causing 3-5 second cold start delays. Users experience slow response times.

## Solution: Hybrid Sentinel + On-Demand Spawn

Maintain ONE persistent Claude process ("sentinel") that handles quick WhatsApp responses. For complex tasks, the sentinel can indicate the need for a full spawn. If the sentinel is busy or crashed, fall back to the existing multi-spawn behavior.

## Architecture

```
Lein Server
├── Sentinel Manager (new)
│   ├── sentinel-loop.sh (bash loop, restarts Claude on exit)
│   ├── Writes new messages to ~/lein-workspace/.sentinel/pending/
│   └── Sentinel Claude polls pending/ and responds
├── Claude Spawner (existing, fallback)
│   └── spawnClaudeForWhatsApp() — used when sentinel unavailable
└── HTTP Server
    └── onNewMessage → write to pending/ (sentinel picks up)
                     → if no sentinel, spawn as before
```

## Message Flow

1. WhatsApp message arrives via webhook
2. Server writes message to `~/lein-workspace/.sentinel/pending/<timestamp>.json`
3. Sentinel Claude (already running) detects new file within 5s polling cycle
4. Sentinel reads message, responds via WhatsApp API, moves file to `processed/`
5. If sentinel is down: server detects via health check, falls back to spawn

## Sentinel Process

### sentinel-loop.sh
```bash
#!/bin/bash
# Ralph Wiggum-style loop: keeps Claude running
while true; do
  claude -p "$(cat ~/lein-workspace/.sentinel/SENTINEL_PROMPT.md)" \
    --dangerously-skip-permissions
  echo "Sentinel exited, restarting in 3s..."
  sleep 3
done
```

### SENTINEL_PROMPT.md
Instructs Claude to:
- Poll `~/lein-workspace/.sentinel/pending/` for new message files
- Read each message, respond via WhatsApp API
- Check every 5 seconds
- Maintain conversation context via session files
- Exit cleanly when no messages for 10 minutes (loop restarts it)

## Health Check

Server determines sentinel health by:
1. PID file at `~/lein-workspace/.sentinel/sentinel.pid`
2. Heartbeat file updated every polling cycle: `.sentinel/heartbeat`
3. If heartbeat older than 30s → sentinel considered dead → use spawn fallback

## Files

### New files:
- `server/src/sentinel.ts` — Sentinel manager (start/stop/health check, message file I/O)
- `scripts/sentinel-loop.sh` — Bash loop that keeps Claude running
- `~/lein-workspace/.sentinel/SENTINEL_PROMPT.md` — Sentinel instructions
- `~/lein-workspace/.sentinel/pending/` — Incoming message queue
- `~/lein-workspace/.sentinel/processed/` — Processed messages
- `~/lein-workspace/.sentinel/sentinel.pid` — PID tracking
- `~/lein-workspace/.sentinel/heartbeat` — Health check

### Modified files:
- `server/src/http-server.ts` — Route messages to sentinel first, spawn as fallback
- `server/src/claude-spawner.ts` — Add sentinel lifecycle management
- `server/src/workspace.ts` — Add sentinel directory constants

### Unchanged:
- Phone call flow
- MCP tool registration
- WhatsApp send/receive API
- Memory system

## Trade-offs

| Aspect | Benefit | Cost |
|--------|---------|------|
| Response time | ~5s polling vs 3-5s cold start | Constant CPU for sentinel |
| Context | Maintains conversation flow | Context window fills over time |
| Reliability | Loop auto-restarts crashes | Single point of failure (mitigated by fallback) |
| Complexity | Clean separation of concerns | New files and message queue system |
