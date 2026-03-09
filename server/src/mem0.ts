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
