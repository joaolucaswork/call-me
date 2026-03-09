/**
 * Lein Workspace
 *
 * Manages the ~/lein-workspace/ directory structure.
 * All sessions, media, and memory live here (not inside the project repo).
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
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
    return readdirSync(githubDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: join(githubDir, e.name) }));
  } catch {
    return [];
  }
}
