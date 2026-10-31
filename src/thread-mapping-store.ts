import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isAmpThreadId } from './amp-transport.js';

const ACP_SESSION_ID_PATTERN = /^S-[a-z0-9]+-[a-z0-9]{6}$/i;

export interface AmpThreadMapping {
  sessionId: string;
  /** Null until the first Amp turn starts a durable thread. */
  threadId: string | null;
  /** Last selected ACP permission mode, if persisted. */
  mode?: string;
  /** Last selected Amp mode, if persisted. */
  model?: string;
  /** Last selected reasoning effort, if persisted. */
  effort?: string;
  /** Last selected execution environment, if persisted. */
  executor?: string;
  /** Working directory the session ran in, if persisted. */
  cwd?: string;
  /** Human-readable session title derived from the first user prompt. */
  title?: string;
  /** ISO 8601 timestamp of the last completed turn. */
  updatedAt?: string;
}

export interface ThreadMappingStore {
  load(sessionId: string): Promise<AmpThreadMapping | null>;
  save(mapping: AmpThreadMapping): Promise<void>;
  list?(): Promise<AmpThreadMapping[]>;
  delete?(sessionId: string): Promise<void>;
}

export function isAcpSessionId(sessionId: string): boolean {
  return ACP_SESSION_ID_PATTERN.test(sessionId);
}

function assertAcpSessionId(sessionId: string): void {
  if (!isAcpSessionId(sessionId)) {
    throw new Error(`Invalid ACP session ID: ${sessionId}`);
  }
}

function validateMapping(value: unknown, expectedSessionId: string): AmpThreadMapping {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid persisted mapping for ACP session ${expectedSessionId}`);
  }
  const mapping = value as Record<string, unknown>;
  if (
    mapping.sessionId !== expectedSessionId
    || (mapping.threadId !== null && !isAmpThreadId(mapping.threadId))
  ) {
    throw new Error(`Invalid persisted mapping for ACP session ${expectedSessionId}`);
  }
  const result: AmpThreadMapping = {
    sessionId: expectedSessionId,
    threadId: mapping.threadId as string | null,
  };
  for (const field of ['mode', 'model', 'effort', 'executor', 'cwd', 'title', 'updatedAt'] as const) {
    const fieldValue = mapping[field];
    if (fieldValue === undefined) continue;
    if (typeof fieldValue !== 'string') {
      throw new Error(`Invalid persisted mapping for ACP session ${expectedSessionId}`);
    }
    result[field] = fieldValue;
  }
  return result;
}

export function defaultAmpAcpStateDir(): string {
  if (process.env.AMP_ACP_STATE_DIR) return process.env.AMP_ACP_STATE_DIR;
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local', 'state');
  return path.join(stateHome, 'amp-acp');
}

export class FileThreadMappingStore implements ThreadMappingStore {
  private sessionsDir: string;

  constructor(stateDir = defaultAmpAcpStateDir()) {
    this.sessionsDir = path.join(stateDir, 'sessions');
  }

  async load(sessionId: string): Promise<AmpThreadMapping | null> {
    assertAcpSessionId(sessionId);
    try {
      const contents = await readFile(this.mappingPath(sessionId), 'utf8');
      return validateMapping(JSON.parse(contents), sessionId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(mapping: AmpThreadMapping): Promise<void> {
    assertAcpSessionId(mapping.sessionId);
    if (mapping.threadId !== null && !isAmpThreadId(mapping.threadId)) {
      throw new Error(`Invalid Amp thread ID: ${mapping.threadId}`);
    }
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
    const destination = this.mappingPath(mapping.sessionId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(mapping)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  }

  async list(): Promise<AmpThreadMapping[]> {
    let names: string[];
    try {
      names = await readdir(this.sessionsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const mappings: AmpThreadMapping[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const sessionId = name.slice(0, -'.json'.length);
      if (!isAcpSessionId(sessionId)) continue;
      try {
        const contents = await readFile(path.join(this.sessionsDir, name), 'utf8');
        mappings.push(validateMapping(JSON.parse(contents), sessionId));
      } catch {
        // Ignore corrupt or partially written records; one bad file must not
        // make every other session undiscoverable.
      }
    }
    return mappings;
  }

  async delete(sessionId: string): Promise<void> {
    assertAcpSessionId(sessionId);
    try {
      await unlink(this.mappingPath(sessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private mappingPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }
}
