import { getLocal } from "mockttp";

export async function mockttpFixture() {
  const server = getLocal();
  await server.start();

  return {
    proxyUrl: `http://host.docker.internal:${String(server.port)}`,
    hostProxyUrl: `http://127.0.0.1:${String(server.port)}`,
    server,
    async [Symbol.asyncDispose]() {
      await server.stop();
    },
  };
}
