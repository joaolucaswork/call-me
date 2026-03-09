# Lein Rebrand & OpenClaw-style Refactor - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebrand CallMe to Lein (feminine persona) and refactor to OpenClaw-style architecture with neutral workspace directory, multi-session support, and persistent global memory.

**Architecture:** Lein server runs as PM2 daemon, spawns Claude Code sessions in `~/lein-workspace/` (neutral directory). Multiple sessions can run in parallel. Global MEMORY.md persists across all sessions. All env vars use `LEIN_` prefix.

**Tech Stack:** TypeScript, Bun, MCP SDK, Twilio/Telnyx, OpenAI, Kapso WhatsApp API, ngrok

**Design doc:** `docs/plans/2026-03-09-lein-rebrand-design.md`

---

### Task 1: Create workspace directory structure

**Files:**
- Create: `server/src/workspace.ts`

**Step 1: Create workspace module**

```typescript
// server/src/workspace.ts
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const WORKSPACE_DIR = join(homedir(), 'lein-workspace');
export const MEMORY_FILE = join(WORKSPACE_DIR, 'MEMORY.md');
export const MEMORY_DIR = join(WORKSPACE_DIR, 'memory');
export const SESSIONS_DIR = join(WORKSPACE_DIR, 'sessions');
export const MEDIA_DIR = join(WORKSPACE_DIR, '.media');

export function ensureWorkspace(): void {
  for (const dir of [WORKSPACE_DIR, MEMORY_DIR, SESSIONS_DIR, MEDIA_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(MEMORY_FILE)) {
    writeFileSync(MEMORY_FILE, '# Lein Memory\n\nMemoria persistente da Lein.\n');
  }
}

export function readMemory(): string {
  try {
    return readFileSync(MEMORY_FILE, 'utf8');
  } catch {
    return '';
  }
}

export function listProjects(): Array<{ name: string; path: string }> {
  const githubDir = join(homedir(), 'Documents', 'GitHub');
  try {
    const { readdirSync } = require('fs');
    return readdirSync(githubDir, { withFileTypes: true })
      .filter((e: any) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e: any) => ({ name: e.name, path: join(githubDir, e.name) }));
  } catch {
    return [];
  }
}
```

**Step 2: Commit**

```bash
git add server/src/workspace.ts
git commit -m "feat: add workspace module for ~/lein-workspace/ directory structure"
```

---

### Task 2: Rebrand environment variables (CALLME_ -> LEIN_)

**Files:**
- Modify: `server/src/providers/index.ts` (lines 55-86 — all `CALLME_` env refs)
- Modify: `server/src/index.ts` (line 17 — `CALLME_API_PORT`)
- Modify: `server/src/http-server.ts` (lines 37-38 — ports, lines 44-46 — public URL, lines 79-84 — greeting)
- Modify: `server/src/phone-call.ts` (grep for `CALLME_` — port, user phone, hold interval, greeting)
- Modify: `server/src/whatsapp.ts` (lines 15-16 — Kapso config)
- Modify: `server/src/ngrok.ts` (grep for `CALLME_`)
- Modify: `.claude-plugin/plugin.json` (all env var names)
- Modify: `server/.env.example` (if exists)

**Step 1: Find-and-replace all CALLME_ with LEIN_ across source files**

In every `.ts` file under `server/src/`, replace `CALLME_` with `LEIN_` using `replace_all`. Key files:

- `providers/index.ts`: `process.env.CALLME_*` → `process.env.LEIN_*` (lines 55-86)
- `index.ts`: `CALLME_API_PORT` → `LEIN_API_PORT` (line 17)
- `http-server.ts`: `CALLME_PORT` → `LEIN_PORT`, `CALLME_API_PORT` → `LEIN_API_PORT`, `CALLME_PUBLIC_URL` → `LEIN_PUBLIC_URL`
- `phone-call.ts`: `CALLME_USER_PHONE_NUMBER` → `LEIN_USER_PHONE_NUMBER`, `CALLME_HOLD_INTERVAL_MS` → `LEIN_HOLD_INTERVAL_MS`, `CALLME_INBOUND_GREETING` → `LEIN_INBOUND_GREETING`
- `whatsapp.ts`: `CALLME_KAPSO_API_KEY` → `LEIN_KAPSO_API_KEY`, `CALLME_KAPSO_PHONE_NUMBER_ID` → `LEIN_KAPSO_PHONE_NUMBER_ID`, `CALLME_OPENAI_API_KEY` → `LEIN_OPENAI_API_KEY`
- `ngrok.ts`: `CALLME_NGROK_AUTHTOKEN` → `LEIN_NGROK_AUTHTOKEN`, `CALLME_NGROK_DOMAIN` → `LEIN_NGROK_DOMAIN`

**Step 2: Update plugin.json**

Replace all `CALLME_` with `LEIN_` in `.claude-plugin/plugin.json`. Also change:
- `"name": "callme"` → `"name": "lein"`
- `"callme":` (mcpServers key) → `"lein":`
- Update description to mention Lein

**Step 3: Update error messages with old name**

Search for string `"CallMe"` and `"callme"` in all source files and replace with `"Lein"` / `"lein"` as appropriate.

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: rebrand CALLME_ env vars to LEIN_ and rename plugin to lein"
```

---

### Task 3: Update session manager to use workspace directory

**Files:**
- Modify: `server/src/session-manager.ts` (line 12 — SESSIONS_DIR)

**Step 1: Update SESSIONS_DIR to use workspace**

Change line 12 from:
```typescript
const SESSIONS_DIR = '/tmp/callme-sessions';
```
to:
```typescript
import { SESSIONS_DIR } from './workspace.js';
```

Remove the local `SESSIONS_DIR` constant. The `ensureDir()` function can stay but use the imported path.

**Step 2: Update log messages**

Replace `[Sessions]` with `[Lein:Sessions]` in log messages for clarity.

**Step 3: Commit**

```bash
git add server/src/session-manager.ts
git commit -m "refactor: move session storage to ~/lein-workspace/sessions/"
```

---

### Task 4: Update WhatsApp module to use workspace directories

**Files:**
- Modify: `server/src/whatsapp.ts` (lines 21-22 — MEDIA_DIR, SESSIONS_DIR)

**Step 1: Replace directory constants**

Change lines 21-22 from:
```typescript
const MEDIA_DIR = join(__dirname, '..', '.media');
const SESSIONS_DIR = join(__dirname, '..', '.whatsapp-sessions');
```
to:
```typescript
import { MEDIA_DIR, SESSIONS_DIR } from './workspace.js';
```

Note: WhatsApp sessions and call sessions now share `~/lein-workspace/sessions/`. The WhatsApp session files are named by phone number (e.g., `558197969570.json`) while call sessions use callId, so they won't conflict.

**Step 2: Commit**

```bash
git add server/src/whatsapp.ts
git commit -m "refactor: move WhatsApp media and sessions to ~/lein-workspace/"
```

---

### Task 5: Refactor claude-spawner for multi-session support

**Files:**
- Modify: `server/src/claude-spawner.ts` (complete rewrite)

**Step 1: Rewrite spawner with multi-session support**

Replace the entire file with:

```typescript
import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { readFileSync } from 'fs';
import { type InboundSession, claimSession } from './session-manager.js';
import { listProjects, readMemory, WORKSPACE_DIR, ensureWorkspace } from './workspace.js';
import type { WhatsAppMessage } from './whatsapp.js';

const CLAUDE_BIN = join(homedir(), '.local', 'bin', 'claude');

interface SpawnedSession {
  pid: number;
  sessionId: string;
  source: 'call' | 'whatsapp';
  startedAt: number;
}

// Track ALL active spawns (multi-session support)
const activeSessions = new Map<string, SpawnedSession>();

// Cleanup stale sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  for (const [id, session] of activeSessions) {
    if (now - session.startedAt > TWO_HOURS) {
      console.error(`[Lein:Spawner] Cleaning up stale session ${id} (PID ${session.pid})`);
      activeSessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

function buildProjectList(): string {
  const projects = listProjects();
  if (projects.length === 0) return 'No projects found in ~/Documents/GitHub/';
  return projects.map(p => `- ${p.name} (${p.path})`).join('\n');
}

function buildBasePrompt(): string {
  const memory = readMemory();
  const projectList = buildProjectList();
  return [
    `--- LEIN MEMORY ---`,
    memory,
    `--- END MEMORY ---`,
    ``,
    `--- AVAILABLE PROJECTS ---`,
    projectList,
    `--- END PROJECTS ---`,
  ].join('\n');
}

export function spawnClaudeForCall(session: InboundSession): boolean {
  ensureWorkspace();
  const baseContext = buildBasePrompt();

  const prompt = [
    `URGENT: There is an active inbound phone call waiting for you!`,
    `You are Lein, a personal AI assistant. Treat yourself as feminine (a Lein).`,
    ``,
    `Call ID: ${session.callId}`,
    `Caller: ${session.from}`,
    `They said: "${session.transcript}"`,
    ``,
    baseContext,
    ``,
    `INSTRUCTIONS:`,
    `1. Use continue_call with call_id="${session.callId}" to respond to the caller immediately`,
    `2. Greet them warmly as Lein`,
    `3. Ask what they'd like to work on`,
    `4. Navigate to the relevant project directory if needed`,
    `5. Keep the call active and follow the caller's instructions`,
    `6. If the caller hangs up, wait for them to call back`,
    `7. Do NOT end the call unless explicitly asked to`,
  ].join('\n');

  return doSpawn(prompt, session.callId, 'call');
}

export function spawnClaudeForWhatsApp(msg: WhatsAppMessage): boolean {
  ensureWorkspace();
  const baseContext = buildBasePrompt();
  const messageContent = msg.transcript || msg.text || msg.caption || '(media message)';
  const mediaInfo = msg.mediaLocalPath ? `\nMedia file saved at: ${msg.mediaLocalPath} (type: ${msg.mimeType})` : '';

  const prompt = [
    `You received a WhatsApp message from the user!`,
    `You are Lein, a personal AI assistant. Treat yourself as feminine (a Lein).`,
    ``,
    `From: ${msg.from}`,
    `Type: ${msg.type}`,
    `Message: "${messageContent}"${mediaInfo}`,
    ``,
    baseContext,
    ``,
    `INSTRUCTIONS:`,
    `1. Use send_whatsapp to respond to the user via WhatsApp`,
    `2. Read their message and respond helpfully`,
    `3. If they mention a project, navigate to it (see project list above)`,
    `4. If they sent audio, it has been auto-transcribed above`,
    `5. If they sent an image, you can read the file at the media path to view it`,
    `6. Use read_whatsapp periodically to check for new messages`,
    `7. Keep monitoring for new WhatsApp messages and respond to each one`,
    `8. You can also use phone calls (initiate_call) if voice communication is better`,
    `9. Send status updates via WhatsApp every 2-3 minutes during long tasks`,
  ].join('\n');

  return doSpawn(prompt, `whatsapp-${msg.id}`, 'whatsapp');
}

function doSpawn(prompt: string, sessionId: string, source: 'call' | 'whatsapp'): boolean {
  console.error(`[Lein:Spawner] Spawning Claude session ${sessionId} in ${WORKSPACE_DIR}`);

  try {
    const child = spawn(CLAUDE_BIN, [
      '--dangerously-skip-permissions',
      '-p',
      prompt,
    ], {
      cwd: WORKSPACE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, HOME: homedir(), CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '' },
    });

    if (!child.pid) {
      console.error('[Lein:Spawner] Failed to spawn Claude process');
      return false;
    }

    activeSessions.set(sessionId, {
      pid: child.pid,
      sessionId,
      source,
      startedAt: Date.now(),
    });

    if (source === 'call') {
      claimSession(sessionId, child.pid);
    }

    console.error(`[Lein:Spawner] Claude spawned with PID ${child.pid} (session: ${sessionId})`);

    child.stdout?.on('data', (data: Buffer) => {
      console.error(`[Lein:${child.pid}:stdout] ${data.toString().trim()}`);
    });

    child.stderr?.on('data', (data: Buffer) => {
      console.error(`[Lein:${child.pid}:stderr] ${data.toString().trim()}`);
    });

    child.on('exit', (code) => {
      console.error(`[Lein:Spawner] Claude PID ${child.pid} exited with code ${code}`);
      activeSessions.delete(sessionId);
    });

    child.on('error', (err) => {
      console.error(`[Lein:Spawner] Claude spawn error:`, err.message);
      activeSessions.delete(sessionId);
    });

    child.unref();
    return true;
  } catch (err) {
    console.error('[Lein:Spawner] Failed to spawn:', err instanceof Error ? err.message : err);
    return false;
  }
}

export function hasActiveSpawn(): boolean {
  return activeSessions.size > 0;
}

export function getActiveSessions(): Map<string, SpawnedSession> {
  return activeSessions;
}

export function getActiveSessionCount(): number {
  return activeSessions.size;
}
```

**Step 2: Update http-server.ts spawn conditions**

In `server/src/http-server.ts`, change the spawn conditions to always allow spawning (remove `!hasActiveSpawn()` check):

Line 107: Change `if (connectedSessions === 0 && !hasActiveSpawn())` to `if (connectedSessions === 0)`
Line 122: Change `if (connectedSessions === 0 && !hasActiveSpawn())` to `if (connectedSessions === 0)`

**Step 3: Commit**

```bash
git add server/src/claude-spawner.ts server/src/http-server.ts
git commit -m "feat: multi-session spawner with workspace dir and memory injection"
```

---

### Task 6: Update project-scanner to return ALL projects (not just most recent)

**Files:**
- Modify: `server/src/project-scanner.ts`

**Step 1: Keep existing findMostRecentProject but use it only for greeting**

The `findMostRecentProject()` function is still used for the inbound greeting. No changes needed here — the `listProjects()` function in `workspace.ts` handles listing all projects for the spawn prompt.

**Step 2: Update greeting to use Lein persona**

In `server/src/http-server.ts`, change the greeting text (around line 79):

From:
```typescript
return `Oi Lucas! Analisei seus projetos e o mais recente é ${project.name}...`
```
To:
```typescript
return `Oi Lucas! Sou a Lein. Analisei seus projetos e o mais recente é ${project.name}, na branch ${project.branch}. ` +
  `Os últimos commits foram: ${commitSummary}. ` +
  (project.gitStatus !== '(clean)' ? `Tem mudanças pendentes. ` : '') +
  `Quer trabalhar nele ou em outro projeto?`;
```

**Step 3: Commit**

```bash
git add server/src/http-server.ts
git commit -m "feat: update inbound greeting with Lein persona"
```

---

### Task 7: Update MCP server identity and log messages

**Files:**
- Modify: `server/src/index.ts`

**Step 1: Update server name and log messages**

- Line 17: `CALLME_API_PORT` → `LEIN_API_PORT` (already done in Task 2, verify)
- Line 89: `CALLME_PUBLIC_URL` → `LEIN_PUBLIC_URL`, `CALLME_NGROK_DOMAIN` → `LEIN_NGROK_DOMAIN`
- Line 149: `{ name: 'callme', version: '3.0.0' }` → `{ name: 'lein', version: '4.0.0' }`
- Line 436: `'CallMe MCP ready'` → `'Lein MCP ready'`

**Step 2: Commit**

```bash
git add server/src/index.ts
git commit -m "refactor: update MCP server identity to Lein"
```

---

### Task 8: Update skill definition

**Files:**
- Modify: `skills/phone-input/SKILL.md`

**Step 1: Update skill to reference Lein**

- Replace `CallMe` with `Lein` throughout
- Replace `callme` with `lein` in tool names (e.g., `mcp__plugin_callme_callme__initiate_call` → `mcp__plugin_lein_lein__initiate_call`)
- Replace `callme.js` script references with `lein.js` (if applicable)
- Update persona references to be feminine

**Step 2: Commit**

```bash
git add skills/phone-input/SKILL.md
git commit -m "refactor: update phone skill to reference Lein persona"
```

---

### Task 9: Update CLAUDE.md and hook scripts

**Files:**
- Modify: `CLAUDE.md`
- Modify: `hooks/inbound-call-hook.sh` (if it references CALLME_)
- Modify: `hooks/check-pending-call.sh` (if it references CALLME_)
- Modify: `hooks/whatsapp-status-hook.sh` (if it references CALLME_)

**Step 1: Update CLAUDE.md**

Replace all references to "CallMe" with "Lein" and `CALLME_` with `LEIN_`. Update the project description:
- "CallMe is a Claude Code plugin..." → "Lein is a personal AI assistant..."
- Update env var names in the documentation

**Step 2: Update hook scripts**

Find all `CALLME_` and `callme` references in hook scripts and replace with `LEIN_`/`lein`.

**Step 3: Commit**

```bash
git add CLAUDE.md hooks/
git commit -m "docs: update CLAUDE.md and hooks for Lein rebrand"
```

---

### Task 10: Initialize workspace and verify

**Step 1: Ensure workspace is initialized on server start**

In `server/src/http-server.ts`, add at the top of `main()`:

```typescript
import { ensureWorkspace } from './workspace.js';
// ... in main():
ensureWorkspace();
```

**Step 2: Update http-server.ts log messages**

Replace `CallMe HTTP Server` with `Lein Server` in log messages (around line 280).

**Step 3: Commit**

```bash
git add server/src/http-server.ts
git commit -m "feat: initialize workspace on server start, update log messages"
```

---

### Task 11: Update .env.example

**Files:**
- Modify: `server/.env.example` (if exists, rename all CALLME_ to LEIN_)

**Step 1: Update or create .env.example**

Rename all `CALLME_` prefixed vars to `LEIN_`. Add a header comment explaining this is the Lein config.

**Step 2: Commit**

```bash
git add server/.env.example
git commit -m "docs: update .env.example for Lein rebrand"
```

---

### Task 12: Final verification

**Step 1: Grep for any remaining CALLME_ references**

```bash
grep -r "CALLME_" server/src/ --include="*.ts"
grep -r "callme" server/src/ --include="*.ts" -i
grep -r "CallMe" . --include="*.ts" --include="*.md" --include="*.json" --include="*.sh"
```

Fix any remaining references.

**Step 2: Verify the server starts**

```bash
cd server && bun run start
```

Check for any import errors or missing references.

**Step 3: Final commit**

```bash
git add -A
git commit -m "chore: clean up remaining CallMe references"
```
