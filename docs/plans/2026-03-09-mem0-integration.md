# Mem0 Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate Mem0 as the persistent memory backend for Lein, replacing the flat MEMORY.md file with semantic memory that supports search, per-project organization, and MCP tools.

**Architecture:** New `mem0.ts` module wraps the Mem0 JS SDK. Four new MCP tools (`remember`, `recall`, `forget`, `list_memories`) are exposed via the existing MCP server and HTTP API. The Claude spawner injects relevant memories from Mem0 (global + project-specific) instead of reading MEMORY.md. MEMORY.md is kept as fallback if Mem0 is offline.

**Tech Stack:** TypeScript, Bun, mem0ai SDK, MCP protocol

---

### Task 1: Install mem0ai SDK and configure API key

**Files:**
- Modify: `server/package.json`
- Modify: `server/.env`

**Step 1: Install the SDK**

Run: `cd /Users/lucas/Documents/GitHub/lein/server && bun add mem0ai`

**Step 2: Add MEM0_API_KEY to .env**

Add to `server/.env`:
```
MEM0_API_KEY=m0-rxMfFOny9n5TYTG4qDBDgTaewdQU045xopdYWHtX
```

**Step 3: Verify import works**

Run: `cd /Users/lucas/Documents/GitHub/lein/server && bun -e "import MemoryClient from 'mem0ai'; console.log('OK')"`
Expected: `OK`

**Step 4: Commit**

```bash
git add server/package.json server/bun.lock
git commit -m "feat: add mem0ai SDK dependency"
```

Note: Do NOT commit .env (it should be in .gitignore).

---

### Task 2: Create mem0.ts module

**Files:**
- Create: `server/src/mem0.ts`

**Step 1: Create the module**

```typescript
/**
 * Mem0 Memory Backend
 *
 * Wraps the Mem0 SDK to provide semantic memory for Lein.
 * Organizes memories by user (global) and project (scoped).
 *
 * Entity scheme:
 *   - "lucas"         → global preferences/facts
 *   - "lucas:lein"    → project-specific memories
 *   - "lucas:kapso"   → project-specific memories
 */

import MemoryClient from 'mem0ai';

let client: InstanceType<typeof MemoryClient> | null = null;

function getClient(): InstanceType<typeof MemoryClient> {
  if (!client) {
    const apiKey = process.env.MEM0_API_KEY;
    if (!apiKey) {
      throw new Error('MEM0_API_KEY not set');
    }
    client = new MemoryClient({ apiKey });
  }
  return client;
}

function userId(project?: string): string {
  return project ? `lucas:${project}` : 'lucas';
}

export async function addMemory(text: string, project?: string): Promise<{ id: string; memory: string }[]> {
  const c = getClient();
  const result = await c.add(
    [{ role: 'user', content: text }],
    { user_id: userId(project) }
  );
  return result.results || result;
}

export async function searchMemory(query: string, project?: string, limit: number = 10): Promise<{ id: string; memory: string; score?: number }[]> {
  const c = getClient();
  const result = await c.search(query, {
    user_id: userId(project),
    limit,
  });
  return result.results || result;
}

export async function getMemories(project?: string, limit: number = 20): Promise<{ id: string; memory: string }[]> {
  const c = getClient();
  const result = await c.getAll({
    user_id: userId(project),
    page_size: limit,
  });
  return result.results || result;
}

export async function deleteMemory(memoryId: string): Promise<void> {
  const c = getClient();
  await c.delete(memoryId);
}

/**
 * Get formatted memory context for Claude spawner.
 * Fetches global memories + project-specific semantic search.
 * Falls back to empty string on error (caller should use MEMORY.md fallback).
 */
export async function getContextForSpawn(message: string, project?: string): Promise<string> {
  try {
    const c = getClient();

    // Fetch global memories (preferences, facts about Lucas)
    const globalMemories = await c.getAll({
      user_id: 'lucas',
      page_size: 10,
    });
    const globalList = (globalMemories.results || globalMemories) as { memory: string }[];

    let projectList: { memory: string; score?: number }[] = [];

    if (project) {
      // Semantic search in project scope using the message as query
      const projectResults = await c.search(message, {
        user_id: userId(project),
        limit: 10,
      });
      projectList = (projectResults.results || projectResults) as { memory: string; score?: number }[];
    }

    const lines: string[] = [];

    if (globalList.length > 0) {
      lines.push('## Global (preferences & facts)');
      for (const m of globalList) {
        lines.push(`- ${m.memory}`);
      }
    }

    if (projectList.length > 0) {
      lines.push('');
      lines.push(`## Project: ${project}`);
      for (const m of projectList) {
        lines.push(`- ${m.memory}`);
      }
    }

    return lines.length > 0 ? lines.join('\n') : '';
  } catch (err) {
    console.error('[Mem0] Failed to fetch context:', err instanceof Error ? err.message : err);
    return ''; // Fallback: caller will use MEMORY.md
  }
}

export function isMem0Configured(): boolean {
  return !!process.env.MEM0_API_KEY;
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/lucas/Documents/GitHub/lein/server && bun build src/mem0.ts --no-bundle 2>&1 | head -5`
Expected: No errors

**Step 3: Commit**

```bash
git add server/src/mem0.ts
git commit -m "feat: add mem0.ts memory backend module"
```

---

### Task 3: Add memory HTTP API endpoints

**Files:**
- Modify: `server/src/http-server.ts:287-336` (switch cases)
- Modify: `server/src/http-server.ts:10-30` (imports)

**Step 1: Add imports to http-server.ts**

After the existing imports (around line 30), add:

```typescript
import { addMemory, searchMemory, getMemories, deleteMemory, isMem0Configured } from './mem0.js';
```

**Step 2: Add API routes inside the switch statement**

Add these cases before the `default:` case (around line 332):

```typescript
          // Memory API routes (Mem0)
          case '/api/memory/remember': {
            if (!isMem0Configured()) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'MEM0_API_KEY not configured' }));
              return;
            }
            result = await addMemory(data.text, data.project);
            break;
          }
          case '/api/memory/recall': {
            if (!isMem0Configured()) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'MEM0_API_KEY not configured' }));
              return;
            }
            result = await searchMemory(data.query, data.project, data.limit);
            break;
          }
          case '/api/memory/list': {
            if (!isMem0Configured()) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'MEM0_API_KEY not configured' }));
              return;
            }
            result = await getMemories(data.project, data.limit);
            break;
          }
          case '/api/memory/forget': {
            if (!isMem0Configured()) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'MEM0_API_KEY not configured' }));
              return;
            }
            await deleteMemory(data.memory_id);
            result = { success: true };
            break;
          }
```

**Step 3: Verify server compiles**

Run: `cd /Users/lucas/Documents/GitHub/lein/server && bun build src/http-server.ts --no-bundle 2>&1 | head -5`
Expected: No errors

**Step 4: Commit**

```bash
git add server/src/http-server.ts
git commit -m "feat: add memory API endpoints (remember, recall, list, forget)"
```

---

### Task 4: Add MCP tools for memory

**Files:**
- Modify: `server/src/index.ts:221-313` (ListToolsRequestSchema handler — add 4 tool definitions)
- Modify: `server/src/index.ts:318-464` (CallToolRequestSchema handler — add 4 tool handlers)

**Step 1: Add 4 new tool definitions after read_whatsapp (around line 312)**

Inside the `tools` array, after the `read_whatsapp` tool object and before the closing `]`:

```typescript
        // Memory tools (Mem0)
        {
          name: 'remember',
          description: 'Save a memory/fact to persistent storage. Use this to remember preferences, decisions, project context, or anything worth preserving across sessions. Memories are automatically deduplicated.',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The fact or memory to save. Be specific and concise.' },
              project: { type: 'string', description: 'Project name (e.g. "lein", "kapso"). Omit for global memories (personal preferences, facts about the user).' },
            },
            required: ['text'],
          },
        },
        {
          name: 'recall',
          description: 'Search memories semantically. Returns the most relevant memories matching your query. Use this to retrieve context before starting work, check past decisions, or find user preferences.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What to search for. Natural language query.' },
              project: { type: 'string', description: 'Project name to search within. Omit to search global memories.' },
              limit: { type: 'number', description: 'Max results (default 10)' },
            },
            required: ['query'],
          },
        },
        {
          name: 'forget',
          description: 'Delete a specific memory by ID. Use when a memory is outdated or incorrect.',
          inputSchema: {
            type: 'object',
            properties: {
              memory_id: { type: 'string', description: 'The memory ID to delete' },
            },
            required: ['memory_id'],
          },
        },
        {
          name: 'list_memories',
          description: 'List all stored memories, optionally filtered by project. Use to review what has been remembered.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Project name to filter. Omit for global memories.' },
              limit: { type: 'number', description: 'Max results (default 20)' },
            },
          },
        },
```

**Step 2: Add tool handlers inside CallToolRequestSchema handler**

After the `read_whatsapp` handler block (around line 462) and before `throw new Error('Unknown tool')`:

```typescript
      // Memory tools
      if (request.params.name === 'remember') {
        const { text, project } = request.params.arguments as { text: string; project?: string };
        const result = await apiCall('/memory/remember', { text, project });
        const memories = result as { id: string; memory: string }[];
        const summary = Array.isArray(memories) && memories.length > 0
          ? memories.map(m => `- ${m.memory} (id: ${m.id})`).join('\n')
          : 'Memory saved.';
        return { content: [{ type: 'text', text: `Remembered${project ? ` [${project}]` : ' [global]'}:\n${summary}` }] };
      }

      if (request.params.name === 'recall') {
        const { query, project, limit } = request.params.arguments as { query: string; project?: string; limit?: number };
        const result = await apiCall('/memory/recall', { query, project, limit });
        const memories = result as { id: string; memory: string; score?: number }[];
        if (!Array.isArray(memories) || memories.length === 0) {
          return { content: [{ type: 'text', text: `No memories found for: "${query}"${project ? ` in project ${project}` : ''}` }] };
        }
        const formatted = memories.map(m => `- ${m.memory} (id: ${m.id}${m.score ? `, score: ${m.score.toFixed(2)}` : ''})`).join('\n');
        return { content: [{ type: 'text', text: `Found ${memories.length} memory/memories${project ? ` [${project}]` : ' [global]'}:\n${formatted}` }] };
      }

      if (request.params.name === 'forget') {
        const { memory_id } = request.params.arguments as { memory_id: string };
        await apiCall('/memory/forget', { memory_id });
        return { content: [{ type: 'text', text: `Memory ${memory_id} deleted.` }] };
      }

      if (request.params.name === 'list_memories') {
        const { project, limit } = request.params.arguments as { project?: string; limit?: number };
        const result = await apiCall('/memory/list', { project, limit });
        const memories = result as { id: string; memory: string }[];
        if (!Array.isArray(memories) || memories.length === 0) {
          return { content: [{ type: 'text', text: `No memories stored${project ? ` for project ${project}` : ' globally'}.` }] };
        }
        const formatted = memories.map(m => `- ${m.memory} (id: ${m.id})`).join('\n');
        return { content: [{ type: 'text', text: `${memories.length} memory/memories${project ? ` [${project}]` : ' [global]'}:\n${formatted}` }] };
      }
```

**Step 3: Verify compilation**

Run: `cd /Users/lucas/Documents/GitHub/lein/server && bun build src/index.ts --no-bundle 2>&1 | head -5`
Expected: No errors

**Step 4: Commit**

```bash
git add server/src/index.ts
git commit -m "feat: add remember, recall, forget, list_memories MCP tools"
```

---

### Task 5: Update Claude spawner to inject Mem0 context

**Files:**
- Modify: `server/src/claude-spawner.ts:1-14` (imports)
- Modify: `server/src/claude-spawner.ts:47-59` (buildBasePrompt)

**Step 1: Add Mem0 import**

Add to imports (after line 13):

```typescript
import { getContextForSpawn, isMem0Configured } from './mem0.js';
```

**Step 2: Make buildBasePrompt async and integrate Mem0**

Replace the `buildBasePrompt` function (lines 47-59) with:

```typescript
async function buildBasePrompt(message?: string, project?: string): Promise<string> {
  const projectList = buildProjectList();
  let memoryContent: string;

  if (isMem0Configured()) {
    const mem0Context = await getContextForSpawn(message || '', project);
    if (mem0Context) {
      memoryContent = mem0Context;
    } else {
      // Mem0 returned nothing — fall back to MEMORY.md
      memoryContent = readMemory();
    }
  } else {
    memoryContent = readMemory();
  }

  return [
    `--- LEIN MEMORY ---`,
    memoryContent,
    `--- END MEMORY ---`,
    ``,
    `--- AVAILABLE PROJECTS ---`,
    projectList,
    `--- END PROJECTS ---`,
  ].join('\n');
}
```

**Step 3: Update callers to await buildBasePrompt**

In `spawnClaudeForCall` (line 66), change:
```typescript
const baseContext = buildBasePrompt();
```
to:
```typescript
const baseContext = await buildBasePrompt(session.transcript);
```

And make the function async:
```typescript
export async function spawnClaudeForCall(session: InboundSession): Promise<boolean> {
```

In `spawnClaudeForWhatsApp` (line 97), change:
```typescript
const baseContext = buildBasePrompt();
```
to:
```typescript
const messageContent = msg.transcript || msg.text || msg.caption || '(media message)';
const baseContext = await buildBasePrompt(messageContent);
```

And make the function async:
```typescript
export async function spawnClaudeForWhatsApp(msg: WhatsAppMessage): Promise<boolean> {
```

Note: The `messageContent` variable is already declared on line 98. Move the existing declaration before `buildBasePrompt` or just use it inline. Remove the duplicate declaration that was on line 98.

**Step 4: Verify compilation**

Run: `cd /Users/lucas/Documents/GitHub/lein/server && bun build src/claude-spawner.ts --no-bundle 2>&1 | head -5`
Expected: No errors

**Step 5: Commit**

```bash
git add server/src/claude-spawner.ts
git commit -m "feat: inject Mem0 context in Claude spawner (with MEMORY.md fallback)"
```

---

### Task 6: End-to-end manual test

**Step 1: Restart the Lein server**

Run: `cd /Users/lucas/Documents/GitHub/lein/server && bun run dev`

**Step 2: Test remember via API**

```bash
curl -X POST http://localhost:3334/api/memory/remember \
  -H 'Content-Type: application/json' \
  -d '{"text": "Lucas prefere usar Bun ao invés de Node.js"}'
```
Expected: JSON response with memory ID

**Step 3: Test recall via API**

```bash
curl -X POST http://localhost:3334/api/memory/recall \
  -H 'Content-Type: application/json' \
  -d '{"query": "qual runtime o Lucas prefere?"}'
```
Expected: Returns the memory about Bun

**Step 4: Test list via API**

```bash
curl -X POST http://localhost:3334/api/memory/list \
  -H 'Content-Type: application/json' \
  -d '{}'
```
Expected: Returns all global memories including the one just added

**Step 5: Test project-scoped memory**

```bash
curl -X POST http://localhost:3334/api/memory/remember \
  -H 'Content-Type: application/json' \
  -d '{"text": "Lein usa ConversationRelay para chamadas telefônicas", "project": "lein"}'
```

```bash
curl -X POST http://localhost:3334/api/memory/recall \
  -H 'Content-Type: application/json' \
  -d '{"query": "como funcionam as chamadas?", "project": "lein"}'
```
Expected: Returns the project-scoped memory

**Step 6: Test forget via API**

Use a memory_id from a previous response:
```bash
curl -X POST http://localhost:3334/api/memory/forget \
  -H 'Content-Type: application/json' \
  -d '{"memory_id": "<id-from-step-2>"}'
```
Expected: `{"success": true}`

**Step 7: Verify MCP tools via Claude Code**

Open a new Claude Code session and test:
- Use `remember` tool to save a fact
- Use `recall` tool to search for it
- Use `list_memories` to see all memories
- Use `forget` to delete a test memory

---

### Summary

| Task | What | Files |
|------|------|-------|
| 1 | Install SDK + env var | package.json, .env |
| 2 | Create mem0.ts module | mem0.ts (new) |
| 3 | HTTP API endpoints | http-server.ts |
| 4 | MCP tools | index.ts |
| 5 | Spawner integration | claude-spawner.ts |
| 6 | Manual E2E test | - |
