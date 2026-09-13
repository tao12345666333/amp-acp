import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isAmpThreadId } from './amp-transport.js';

const ACP_SESSION_ID_PATTERN = /^S-[a-z0-9]+-[a-z0-9]{6}$/i;

export interface AmpThreadMapping {
  sessionId: string;
  threadId: string;
}

export interface ThreadMappingStore {
  load(sessionId: string): Promise<AmpThreadMapping | null>;
  save(mapping: AmpThreadMapping): Promise<void>;
}

function assertAcpSessionId(sessionId: string): void {
  if (!ACP_SESSION_ID_PATTERN.test(sessionId)) {
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
    || !isAmpThreadId(mapping.threadId)
  ) {
    throw new Error(`Invalid persisted mapping for ACP session ${expectedSessionId}`);
  }
  return {
    sessionId: expectedSessionId,
    threadId: mapping.threadId,
  };
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
    if (!isAmpThreadId(mapping.threadId)) {
      throw new Error(`Invalid Amp thread ID: ${mapping.threadId}`);
    }
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
    const destination = this.mappingPath(mapping.sessionId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(mapping)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  }

  private mappingPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }
}
