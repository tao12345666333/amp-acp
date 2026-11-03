import { ndJsonStream } from '@agentclientprotocol/sdk/unstable';
import { createAgentApp } from './agent-app.js';
import { nodeToWebWritable, nodeToWebReadable } from './utils.js';

export function runAcp(): void {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(
    input as unknown as WritableStream<Uint8Array>,
    output as unknown as ReadableStream<Uint8Array>,
  );
  const { app, getAgent } = createAgentApp();
  const connection = app.connect(stream);

  const close = () => getAgent()?.close();
  void connection.closed.finally(close);
  process.once('exit', close);
  process.once('SIGINT', () => {
    close();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    close();
    process.exit(143);
  });
}
