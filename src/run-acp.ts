import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { nodeToWebWritable, nodeToWebReadable } from './utils.js';
import { AmpAcpAgent } from './server.js';

export function runAcp(): void {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(
    input as unknown as WritableStream<Uint8Array>,
    output as unknown as ReadableStream<Uint8Array>,
  );
  new AgentSideConnection((client) => new AmpAcpAgent(client), stream);
}
