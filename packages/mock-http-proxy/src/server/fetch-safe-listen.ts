import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const fetchForbiddenPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function listenForTcpServer(
  server: Server,
  { host, port }: { host: string; port: number },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);

    try {
      server.listen(port, host);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export async function listenOnFetchSafePort(
  server: Server,
  { host = "127.0.0.1", port = 0 }: { host?: string; port?: number } = {},
): Promise<{ host: string; port: number; url: string }> {
  if (port !== 0 && fetchForbiddenPorts.has(port)) {
    throw new Error(`Port ${String(port)} is blocked by Fetch`);
  }

  for (let attempt = 1; attempt <= 50; attempt++) {
    await listenForTcpServer(server, { host, port });

    const address = server.address() as AddressInfo | string | null;
    if (!address || typeof address === "string") {
      throw new Error(`Expected TCP server address, got ${JSON.stringify(address)}`);
    }

    if (!fetchForbiddenPorts.has(address.port)) {
      return {
        host,
        port: address.port,
        url: `http://${host}:${String(address.port)}`,
      };
    }

    await closeServer(server);
  }

  throw new Error("Could not bind a Fetch-safe port after 50 attempts");
}
