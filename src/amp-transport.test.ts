import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  type AmpPromptContent,
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
if (prompt.startsWith('{') && !process.argv.includes('--stream-json-input')) throw new Error('missing JSON input flag');
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

  it('passes reasoning effort as a CLI thread feature and streams thinking', () => {
    expect(buildAmpCliArgs({
      ...baseOptions,
      effort: 'high',
      thinking: true,
    })).toEqual([
      '--execute',
      '--stream-json-thinking',
      '--no-archive-after-execute',
      '--mode',
      'medium',
      '--features',
      'effort:high',
    ]);
    expect(buildAmpSdkOptions({
      ...baseOptions,
      effort: 'xhigh',
      thinking: true,
    })).toMatchObject({
      thinking: true,
      noArchiveAfterExecute: true,
    });
    // The SDK's `--effort` flag is not accepted by current Amp CLI releases.
    expect(buildAmpSdkOptions({
      ...baseOptions,
      effort: 'xhigh',
    })).not.toHaveProperty('effort');
  });

  it('passes custom plugin agent modes through to the CLI and SDK', () => {
    expect(buildAmpCliArgs({ ...baseOptions, mode: 'acp-flash' })).toEqual([
      '--execute',
      '--stream-json',
      '--no-archive-after-execute',
      '--mode',
      'acp-flash',
    ]);
    expect(buildAmpSdkOptions({ ...baseOptions, mode: 'acp-flash' })).toMatchObject({
      mode: 'acp-flash',
      noArchiveAfterExecute: true,
    });
  });

  it('passes Orb execution options through to the SDK', () => {
    expect(buildAmpSdkOptions({
      ...baseOptions,
      executor: 'orb',
      project: 'acme/widgets',
    })).toMatchObject({
      executor: 'orb',
      project: 'acme/widgets',
    });
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

  it('sends ordered image blocks as one JSON Lines user message', async () => {
    const content: AmpPromptContent[] = [
      { type: 'text', text: 'before' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      { type: 'text', text: 'after' },
    ];
    const executableFixture = path.join(fixtureDir, 'fake-amp-executable');
    await writeFile(executableFixture, `#!${process.execPath}\n${await Bun.file(fixturePath).text()}`, { mode: 0o700 });
    const originalCliPath = process.env.AMP_CLI_PATH;
    process.env.AMP_CLI_PATH = executableFixture;
    try {
      for (const transport of [createCliTransport(process.execPath, [fixturePath]), createAmpTransport('sdk')]) {
        const messages = await collect(transport.execute({
          prompt: 'beforeafter', content,
          options: { ...baseOptions, cwd: fixtureDir },
          signal: new AbortController().signal,
        }));
        expect(messages.at(-1)).toMatchObject({ result: JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n' });
      }
    } finally {
      if (originalCliPath === undefined) delete process.env.AMP_CLI_PATH;
      else process.env.AMP_CLI_PATH = originalCliPath;
    }
  });

  it('uploads every Orb image as a private attachment and cleans up on success, failure, and cancellation', async () => {
    const attachmentFixture = path.join(fixtureDir, 'attachments.mjs');
    await writeFile(attachmentFixture, `
import { readFile, stat } from 'node:fs/promises';
const args = process.argv.slice(2);
if (!args.includes('--orb-execute') || args.includes('--stream-json-input')) throw new Error('wrong remote input route');
const images = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--attach') {
    const file = args[++i];
    images.push({ file, data: (await readFile(file)).toString('base64'), mode: (await stat(file)).mode & 0o777 });
  }
}
let text = '';
for await (const chunk of process.stdin) text += chunk;
console.log(JSON.stringify({ type: 'user', message: { content: images } }));
if (text === 'fail') { console.error('upload failed'); process.exit(2); }
if (text === 'wait') await new Promise(resolve => setTimeout(resolve, 30000));
console.log(JSON.stringify({ type: 'result', is_error: false, result: text }));
`);
    const transport = createCliTransport(process.execPath, [attachmentFixture]);
    const content: AmpPromptContent[] = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BAU=' } },
    ];
    for (const prompt of ['describe both', 'fail', 'wait']) {
      const messages: AmpStreamMessage[] = [];
      const controller = new AbortController();
      const stream = transport.execute({ prompt, content, options: { ...baseOptions, cwd: fixtureDir, executor: 'orb' }, signal: controller.signal });
      const run = async () => {
        for await (const message of stream) messages.push(message);
      };
      if (prompt === 'fail') await expect(run()).rejects.toThrow('upload failed');
      else if (prompt === 'wait') {
        const iterator = stream[Symbol.asyncIterator]();
        messages.push((await iterator.next()).value!);
        controller.abort();
        await expect(iterator.next()).rejects.toThrow('aborted');
      }
      else await run();
      const images = messages[0]?.message?.content as { file: string; data: string; mode: number }[];
      expect(images.map(({ data }) => data)).toEqual(['AQID', 'BAU=']);
      expect(images.map(({ mode }) => mode)).toEqual([0o600, 0o600]);
      for (const image of images) await expect(access(path.dirname(image.file))).rejects.toThrow();
      if (prompt === 'describe both') expect(messages.at(-1)).toMatchObject({ result: prompt });
    }
  });

  it('uses the CLI Orb route when the SDK transport receives image content', async () => {
    const orbFixture = path.join(fixtureDir, 'sdk-orb-attachments.mjs');
    await writeFile(orbFixture, `
import { readFile, stat } from 'node:fs/promises';
const args = process.argv.slice(2);
if (!args.includes('--orb-execute') || args.includes('--stream-json-input')) throw new Error('wrong remote input route');
const images = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--attach') {
    const file = args[++i];
    images.push({ file, data: (await readFile(file)).toString('base64'), mode: (await stat(file)).mode & 0o777 });
  }
}
console.log(JSON.stringify({ type: 'user', message: { content: images } }));
console.log(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }));
`);
    const executableFixture = path.join(fixtureDir, 'sdk-orb-executable');
    await writeFile(executableFixture, `#!${process.execPath}\n${await Bun.file(orbFixture).text()}`, { mode: 0o700 });
    const originalCliPath = process.env.AMP_CLI_PATH;
    process.env.AMP_CLI_PATH = executableFixture;
    try {
      const content: AmpPromptContent[] = [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BAU=' } },
      ];
      const messages = await collect(createAmpTransport('sdk').execute({
        prompt: 'describe both',
        content,
        options: { ...baseOptions, cwd: fixtureDir, executor: 'orb' },
        signal: new AbortController().signal,
      }));
      const images = messages[0]?.message?.content as { file: string; data: string; mode: number }[];
      expect(images.map(({ data }) => data)).toEqual(['AQID', 'BAU=']);
      expect(images.map(({ mode }) => mode)).toEqual([0o600, 0o600]);
      for (const image of images) await expect(access(path.dirname(image.file))).rejects.toThrow();
      expect(messages.at(-1)).toMatchObject({ result: 'ok' });
    } finally {
      if (originalCliPath === undefined) delete process.env.AMP_CLI_PATH;
      else process.env.AMP_CLI_PATH = originalCliPath;
    }
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
