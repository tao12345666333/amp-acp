import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileThreadMappingStore } from './thread-mapping-store.js';

const sessionId = 'S-mabc123-abcdef';
const threadId = 'T-01a03c00-e608-7007-8181-5c1cc56757be';

describe('FileThreadMappingStore', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-state-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('retains the exact ACP-to-Amp mapping across store restarts', async () => {
    const firstProcess = new FileThreadMappingStore(stateDir);
    await firstProcess.save({ sessionId, threadId });

    const restartedProcess = new FileThreadMappingStore(stateDir);
    expect(await restartedProcess.load(sessionId)).toEqual({
      sessionId,
      threadId,
    });
  });

  it('returns null for a legacy session with no persisted mapping', async () => {
    const store = new FileThreadMappingStore(stateDir);

    expect(await store.load('S-legacy-abcdef')).toBeNull();
  });

  it('rejects invalid session and thread IDs instead of creating unsafe paths or mappings', async () => {
    const store = new FileThreadMappingStore(stateDir);

    await expect(store.save({
      sessionId: '../other-session',
      threadId,
    })).rejects.toThrow('Invalid ACP session ID');
    await expect(store.save({
      sessionId,
      threadId: 'T-not-a-thread',
    })).rejects.toThrow('Invalid Amp thread ID');
    await expect(store.load('../other-session')).rejects.toThrow('Invalid ACP session ID');
  });
});
