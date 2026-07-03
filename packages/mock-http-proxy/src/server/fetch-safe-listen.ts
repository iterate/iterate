import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080,
]);

export type FetchSafeListenResult = {
  baseUrl: string;
  host: string;
  port: number;
};

type FetchSafeListenOptions = {
  host?: string;
  port?: number;
  maxAttempts?: number;
  isFetchBlockedPort?: (port: number) => boolean;
};

export function isFetchBlockedPort(port: number): boolean {
  return FETCH_BLOCKED_PORTS.has(port);
}

export async function listenOnFetchSafePort(
  server: Server,
  options: FetchSafeListenOptions = {},
): Promise<FetchSafeListenResult> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const maxAttempts = options.maxAttempts ?? 16;
  const isBlocked = options.isFetchBlockedPort ?? isFetchBlockedPort;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await listenOnce(server, requestedPort, host);
    const address = server.address();
    if (!isAddressInfo(address)) {
      await closeServer(server);
      throw new Error("Expected TCP server address after listening");
    }

    if (!isBlocked(address.port)) {
      return {
        baseUrl: `http://${formatUrlHost(host)}:${String(address.port)}`,
        host,
        port: address.port,
      };
    }

    await closeServer(server);
    if (requestedPort !== 0) {
      throw new Error(`Port ${String(address.port)} is blocked by Fetch`);
    }
  }

  throw new Error(
    `Could not find a Fetch-safe ephemeral port after ${String(maxAttempts)} attempts`,
  );
}

async function listenOnce(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

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

function isAddressInfo(address: ReturnType<Server["address"]>): address is AddressInfo {
  return typeof address === "object" && address !== null && "port" in address;
}

function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
