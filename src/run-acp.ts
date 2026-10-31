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
  let agent: AmpAcpAgent | undefined;
  const connection = new AgentSideConnection((client) => {
    agent = new AmpAcpAgent(client);
    return agent;
  }, stream);

  const close = () => agent?.close();
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
