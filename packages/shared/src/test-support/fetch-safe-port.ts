import type { AddressInfo, Server } from "node:net";

/**
 * Ports the WHATWG fetch spec blocks outright
 * (https://fetch.spec.whatwg.org/#bad-port). Node's fetch (undici) refuses to
 * connect to any of them — `TypeError: fetch failed` caused by `Error: bad
 * port` — before a single packet is sent. `listen(0)` can be handed one of
 * these where the OS ephemeral port range is widened past its defaults (CI
 * containers).
 */
const WHATWG_FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

/**
 * Bind `server` to an OS-assigned loopback port that fetch will actually
 * connect to, re-rolling the rare blocked assignment. Returns the bound port.
 */
export async function listenOnFetchSafePort(server: Server): Promise<number> {
  for (let attempt = 1; attempt <= 16; attempt += 1) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    if (!WHATWG_FETCH_BLOCKED_PORTS.has(port)) return port;
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error("no fetch-safe loopback port assigned after 16 attempts");
}
