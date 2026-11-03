import {
  agent,
  methods,
  type AgentApp,
  type AgentContext,
} from '@agentclientprotocol/sdk/unstable';
import type { AcpClient } from './acp-client.js';
import { AmpAcpAgent } from './server.js';

export function toAcpClient(client: AgentContext): AcpClient {
  return {
    sessionUpdate: (notification) => client.notify(methods.client.session.update, notification),
    notify: (method, params) => client.notify(method, params),
  };
}

export function createAgentApp(
  createAgent: (client: AcpClient) => AmpAcpAgent = (client) => new AmpAcpAgent(client),
): { app: AgentApp; getAgent: () => AmpAcpAgent | undefined } {
  let agentInstance: AmpAcpAgent | undefined;
  const app = agent()
    .onConnect((connection) => {
      agentInstance = createAgent(toAcpClient(connection.client));
    })
    .onRequest(methods.agent.initialize, ({ params }) => agentInstance!.initialize(params))
    .onRequest(methods.agent.authenticate, ({ params }) => agentInstance!.authenticate(params))
    .onRequest(methods.agent.session.new, ({ params }) => agentInstance!.newSession(params))
    .onRequest(methods.agent.session.load, ({ params }) => agentInstance!.loadSession(params))
    .onRequest(methods.agent.session.list, ({ params }) => agentInstance!.listSessions(params))
    .onRequest(methods.agent.session.delete, ({ params }) => agentInstance!.deleteSession(params))
    .onRequest(methods.agent.session.resume, ({ params }) => agentInstance!.resumeSession(params))
    .onRequest(methods.agent.session.close, ({ params }) => agentInstance!.closeSession(params))
    .onRequest(methods.agent.session.setMode, ({ params }) => agentInstance!.setSessionMode(params))
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => agentInstance!.setSessionConfigOption(params))
    .onRequest(methods.agent.session.prompt, ({ params }) => agentInstance!.prompt(params))
    .onNotification(methods.agent.session.cancel, ({ params }) => agentInstance!.cancel(params))
    .onRequest('*', ({ method, params }) =>
      agentInstance!.extMethod(method, params as Record<string, unknown>));

  return { app, getAgent: () => agentInstance };
}
