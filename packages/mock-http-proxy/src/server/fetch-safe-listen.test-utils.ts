import { once } from "node:events";
import type { Server } from "node:http";

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6697, 10080,
]);

const MAX_LISTEN_ATTEMPTS = 50;

export async function listenOnFetchSafePort(
  server: Server,
): Promise<{ baseUrl: string; port: number }> {
  for (let attempt = 0; attempt < MAX_LISTEN_ATTEMPTS; attempt += 1) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      await closeServer(server);
      throw new Error("Expected TCP server to listen on an assigned port.");
    }

    if (!FETCH_FORBIDDEN_PORTS.has(address.port) && (address.port < 6665 || address.port > 6669)) {
      return {
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        port: address.port,
      };
    }

    await closeServer(server);
  }

  throw new Error(`Could not find a fetch-safe ephemeral port after ${MAX_LISTEN_ATTEMPTS} tries.`);
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
