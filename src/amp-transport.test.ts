import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildAmpCliArgs,
  buildAmpSdkOptions,
  createAmpTransport,
  createCliTransport,
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
