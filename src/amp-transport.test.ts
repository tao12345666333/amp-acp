import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildAmpArchiveArgs,
  buildAmpCliArgs,
  buildAmpSdkOptions,
  createAmpTransport,
  createCliTransport,
  isAmpThreadId,
  setAmpThreadArchived,
  type AmpExecutionOptions,
  type AmpStreamMessage,
} from './amp-transport.js';

const baseOptions: AmpExecutionOptions = {
  cwd: '/tmp/project',
  env: { TERM: 'dumb' },
  mode: 'medium',
};

let fixtureDir: string;
let fixturePath: string;

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'amp-transport-test-'));
  fixturePath = path.join(fixtureDir, 'fake-amp.mjs');
  await writeFile(fixturePath, `
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (prompt === 'fail') {
  console.error('fixture failure');
  process.exit(2);
}
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'T-cli-test' }));
if (prompt === 'wait') await new Promise((resolve) => setTimeout(resolve, 30000));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: prompt }));
`);
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function collect(stream: AsyncIterable<AmpStreamMessage>): Promise<AmpStreamMessage[]> {
  const messages: AmpStreamMessage[] = [];
  for await (const message of stream) messages.push(message);
  return messages;
}

describe('Amp transport', () => {
  it('accepts only durable Amp thread IDs', () => {
    expect(isAmpThreadId('T-01a03c00-e608-7007-8181-5c1cc56757be')).toBe(true);
    expect(isAmpThreadId('S-01a03c00-e608-7007-8181-5c1cc56757be')).toBe(false);
    expect(isAmpThreadId('T-test-thread')).toBe(false);
    expect(isAmpThreadId('T-01a03c00-e608-7007-8181-5c1cc56757be; rm -rf /')).toBe(false);
  });

  it('builds exact archive and unarchive arguments', () => {
    const threadId = 'T-01a03c00-e608-7007-8181-5c1cc56757be';

    expect(buildAmpArchiveArgs(threadId, true)).toEqual(['threads', 'archive', threadId]);
    expect(buildAmpArchiveArgs(threadId, false)).toEqual(['threads', 'archive', '--unarchive', threadId]);
    expect(() => buildAmpArchiveArgs('S-not-an-amp-thread', true)).toThrow('Invalid Amp thread ID');
  });

  it('archives and unarchives by invoking the configured Amp CLI directly', async () => {
    const argsPath = path.join(fixtureDir, 'archive-args.json');
    const lifecycleFixture = path.join(fixtureDir, 'fake-archive.mjs');
    const threadId = 'T-01a03c00-e608-7007-8181-5c1cc56757be';
    await writeFile(lifecycleFixture, `
import { writeFile } from 'node:fs/promises';
await writeFile(process.env.ARGS_PATH, JSON.stringify(process.argv.slice(2)));
`);

    await setAmpThreadArchived(threadId, true, {
      command: process.execPath,
      commandArgs: [lifecycleFixture],
      env: { ARGS_PATH: argsPath },
    });
    expect(JSON.parse(await Bun.file(argsPath).text())).toEqual([
      'threads',
      'archive',
      threadId,
    ]);

    await setAmpThreadArchived(threadId, false, {
      command: process.execPath,
      commandArgs: [lifecycleFixture],
      env: { ARGS_PATH: argsPath },
    });
    expect(JSON.parse(await Bun.file(argsPath).text())).toEqual([
      'threads',
      'archive',
      '--unarchive',
      threadId,
    ]);
  });

  it('surfaces Amp CLI archive failures', async () => {
    const lifecycleFixture = path.join(fixtureDir, 'failing-archive.mjs');
    await writeFile(lifecycleFixture, `
console.error('archive fixture failure');
process.exit(3);
`);

    await expect(setAmpThreadArchived(
      'T-01a03c00-e608-7007-8181-5c1cc56757be',
      true,
      { command: process.execPath, commandArgs: [lifecycleFixture] },
    )).rejects.toThrow('Amp CLI process exited with code 3: archive fixture failure');
  });

  it('uses the CLI transport by default', () => {
    const originalTransport = process.env.AMP_ACP_TRANSPORT;
    delete process.env.AMP_ACP_TRANSPORT;
    try {
      expect(createAmpTransport().name).toBe('cli');
    } finally {
      if (originalTransport === undefined) {
        delete process.env.AMP_ACP_TRANSPORT;
      } else {
        process.env.AMP_ACP_TRANSPORT = originalTransport;
      }
    }
  });

  it('selects both supported transports', () => {
    expect(createAmpTransport('sdk').name).toBe('sdk');
    expect(createAmpTransport('cli').name).toBe('cli');
    expect(() => createAmpTransport('other')).toThrow('Unsupported AMP_ACP_TRANSPORT: other');
  });

  it('builds arguments for a new CLI thread', () => {
    expect(buildAmpCliArgs(baseOptions)).toEqual([
      '--execute',
      '--stream-json',
      '--no-archive-after-execute',
      '--mode',
      'medium',
    ]);
  });

  it('passes current modes through to the SDK', () => {
    for (const mode of ['low', 'medium', 'high', 'ultra'] as const) {
      expect(buildAmpSdkOptions({ ...baseOptions, mode })).toMatchObject({
        mode,
        noArchiveAfterExecute: true,
      });
    }
  });

  it('builds arguments for continuing a specific CLI thread', () => {
    expect(buildAmpCliArgs({
      ...baseOptions,
      continue: 'T-test-thread',
      dangerouslyAllowAll: true,
      mcpConfig: { exa: { url: 'https://mcp.exa.ai/mcp' } },
    })).toEqual([
      'threads',
      'continue',
      'T-test-thread',
      '--execute',
      '--stream-json',
      '--no-archive-after-execute',
      '--mode',
      'medium',
      '--dangerously-allow-all',
      '--mcp-config',
      '{"exa":{"url":"https://mcp.exa.ai/mcp"}}',
    ]);
  });

  it('continues the latest CLI thread when requested', () => {
    expect(buildAmpCliArgs({ ...baseOptions, continue: true }).slice(0, 4)).toEqual([
      'threads',
      'continue',
      '--last',
      '--execute',
    ]);
  });

  it('streams JSON messages from the CLI process', async () => {
    const controller = new AbortController();
    const transport = createCliTransport(process.execPath, [fixturePath]);

    const messages = await collect(transport.execute({
      prompt: 'hello from ACP',
      options: { ...baseOptions, cwd: fixtureDir },
      signal: controller.signal,
    }));

    expect(messages).toEqual([
      { type: 'system', subtype: 'init', session_id: 'T-cli-test' },
      { type: 'result', subtype: 'success', is_error: false, result: 'hello from ACP' },
    ]);
  });

  it('includes CLI stderr when the process fails', async () => {
    const transport = createCliTransport(process.execPath, [fixturePath]);

    await expect(collect(transport.execute({
      prompt: 'fail',
      options: { ...baseOptions, cwd: fixtureDir },
      signal: new AbortController().signal,
    }))).rejects.toThrow('Amp CLI process exited with code 2: fixture failure');
  });

  it('terminates the CLI process when cancelled', async () => {
    const controller = new AbortController();
    const transport = createCliTransport(process.execPath, [fixturePath]);
    const iterator = transport.execute({
      prompt: 'wait',
      options: { ...baseOptions, cwd: fixtureDir },
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.type).toBe('system');
    controller.abort();
    await expect(iterator.next()).rejects.toThrow('Amp CLI process was aborted');
  });
});
