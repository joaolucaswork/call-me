/**
 * Project Scanner
 *
 * Scans ~/Documents/GitHub/ to find the most recently modified project
 * and gathers context (recent commits, git status, description) so
 * Claude can immediately suggest work without exploring the codebase.
 */

import { execSync } from 'child_process';
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const GITHUB_DIR = join(homedir(), 'Documents', 'GitHub');

export interface ProjectContext {
  name: string;
  path: string;
  lastModified: Date;
  recentCommits: string[];      // Last 5 commit messages
  gitStatus: string;            // Current uncommitted changes
  branch: string;               // Current branch
  description: string | null;   // From CLAUDE.md or README
}

function git(cwd: string, args: string): string {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return '';
  }
}

/**
 * Find the most recently modified project by checking git commit dates,
 * falling back to directory mtime.
 */
export function findMostRecentProject(): ProjectContext | null {
  let entries: { name: string; path: string }[];
  try {
    entries = readdirSync(GITHUB_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: join(GITHUB_DIR, e.name) }));
  } catch {
    return null;
  }

  // Score each project by most recent git commit timestamp
  let best: { entry: typeof entries[0]; timestamp: number } | null = null;

  for (const entry of entries) {
    // Try git commit timestamp first (more accurate than mtime)
    const commitTs = git(entry.path, 'log -1 --format=%ct 2>/dev/null');
    let timestamp = commitTs ? parseInt(commitTs, 10) * 1000 : 0;

    // Fallback to directory mtime
    if (!timestamp) {
      try {
        timestamp = statSync(entry.path).mtimeMs;
      } catch {
        continue;
      }
    }

    if (!best || timestamp > best.timestamp) {
      best = { entry, timestamp };
    }
  }

  if (!best) return null;

  return gatherContext(best.entry.name, best.entry.path, new Date(best.timestamp));
}

function gatherContext(name: string, projectPath: string, lastModified: Date): ProjectContext {
  // Recent commits
  const logOutput = git(projectPath, 'log --oneline -5 2>/dev/null');
  const recentCommits = logOutput ? logOutput.split('\n').filter(Boolean) : [];

  // Git status
  const gitStatus = git(projectPath, 'status --short 2>/dev/null') || '(clean)';

  // Current branch
  const branch = git(projectPath, 'branch --show-current 2>/dev/null') || 'unknown';

  // Description from CLAUDE.md or README
  let description: string | null = null;
  for (const file of ['CLAUDE.md', 'README.md', 'readme.md']) {
    const filePath = join(projectPath, file);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf8');
        // Take first ~500 chars (enough for overview)
        description = content.substring(0, 500);
        if (content.length > 500) description += '\n...';
        break;
      } catch {
        continue;
      }
    }
  }

  return { name, path: projectPath, lastModified, recentCommits, branch, gitStatus, description };
}

/**
 * Format project context as a readable summary for Claude's prompt.
 */
export function formatProjectSummary(ctx: ProjectContext): string {
  const lines = [
    `Project: ${ctx.name}`,
    `Path: ${ctx.path}`,
    `Branch: ${ctx.branch}`,
    `Last activity: ${ctx.lastModified.toLocaleString('pt-BR')}`,
    ``,
    `Recent commits:`,
    ...ctx.recentCommits.map(c => `  ${c}`),
    ``,
    `Git status: ${ctx.gitStatus}`,
  ];

  if (ctx.description) {
    lines.push(``, `Project description:`, ctx.description);
  }

  return lines.join('\n');
}
