// A node-side egress HTTPS proxy for `pnpm cli itx egress-proxy`. It implements
// the EgressHttpsProxy contract (dial -> read/write/close): it only opens TCP
// sockets and shuttles bytes. The worker substitutes secrets and terminates TLS
// itself, so this process sees the target host/port and byte counts — never the
// request, body, or substituted secret. Outbound traffic leaves from THIS
// machine's IP, so the proxy is a non-MITM HTTPS forward proxy.
import net from "node:net";
import { RpcTarget } from "capnweb";
import type { EgressHttpsProxy, EgressHttpsProxyConnection } from "../src/types.ts";

export type DialSummary = {
  host: string;
  port: number;
  remoteAddress?: string;
  sni: string | null;
};

class ProxyConnection extends RpcTarget implements EgressHttpsProxyConnection {
  #bytesUp = 0;
  #bytesDown = 0;
  #firstUp: Uint8Array | null = null;
  readonly #queue: Uint8Array[] = [];
  readonly #waiters: Array<{ reject(e: unknown): void; resolve(c: Uint8Array | null): void }> = [];
  #closed = false;
  #error: unknown;

  constructor(
    readonly summary: DialSummary,
    readonly socket: net.Socket,
    readonly onClose: (bytesUp: number, bytesDown: number) => void,
  ) {
    super();
    socket.on("data", (chunk: Buffer) => {
      this.#bytesDown += chunk.byteLength;
      const bytes = new Uint8Array(chunk);
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(bytes);
      else this.#queue.push(bytes);
    });
    socket.once("close", () => this.#finish(null));
    socket.once("end", () => this.#finish(null));
    socket.once("error", (error) => {
      this.#error = error;
      this.#finish(error);
    });
  }

  async read(): Promise<Uint8Array | null> {
    if (this.#queue.length > 0) return this.#queue.shift()!;
    if (this.#error !== undefined) throw this.#error;
    if (this.#closed) return null;
    return await new Promise((resolve, reject) => this.#waiters.push({ reject, resolve }));
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.#bytesUp += chunk.byteLength;
    if (this.#firstUp === null) {
      this.#firstUp = chunk.slice(0, 512);
      this.summary.sni = extractTlsClientHelloSni(this.#firstUp);
    }
    await new Promise<void>((resolve, reject) =>
      this.socket.write(chunk, (error) => (error ? reject(error) : resolve())),
    );
  }

  async close(): Promise<void> {
    this.socket.destroy();
    this.#finish(null);
  }

  #finish(error: unknown) {
    if (this.#closed) return;
    this.#closed = true;
    this.onClose(this.#bytesUp, this.#bytesDown);
    for (const waiter of this.#waiters.splice(0)) {
      if (error === null) waiter.resolve(null);
      else waiter.reject(error);
    }
  }
}

export class EgressProxyRelay extends RpcTarget implements EgressHttpsProxy, Disposable {
  #count = 0;
  readonly #sockets = new Set<net.Socket>();

  constructor(readonly opts: { onDial?: (info: DialSummary & { id: number }) => void } = {}) {
    super();
  }

  async dial(input: { host: string; port: number }): Promise<EgressHttpsProxyConnection> {
    const id = ++this.#count;
    const socket = net.connect({ host: input.host, port: input.port });
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    const summary: DialSummary = { host: input.host, port: input.port, sni: null };
    socket.once("connect", () => {
      summary.remoteAddress = socket.remoteAddress;
    });
    this.opts.onDial?.({ ...summary, id });
    return new ProxyConnection(summary, socket, (bytesUp, bytesDown) => {
      console.log(
        `  [#${id}] closed — ${input.host}:${input.port}` +
          (summary.sni ? ` (SNI ${summary.sni})` : "") +
          ` — sent ${bytesUp} encrypted bytes, received ${bytesDown}`,
      );
    });
  }

  [Symbol.dispose](): void {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
  }
}

// Peek the SNI out of the first ClientHello so the operator can see WHICH host
// the worker dialed, without being able to read any of the encrypted payload.
function extractTlsClientHelloSni(bytes: Uint8Array): string | null {
  try {
    if (bytes.length < 5 || bytes[0] !== 22) return null;
    let offset = 5 + 4 + 2 + 32;
    const sessionIdLength = bytes[offset]!;
    offset += 1 + sessionIdLength;
    const cipherSuitesLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    offset += 2 + cipherSuitesLength;
    const compressionMethodsLength = bytes[offset]!;
    offset += 1 + compressionMethodsLength;
    const extensionsEnd = offset + 2 + ((bytes[offset]! << 8) | bytes[offset + 1]!);
    offset += 2;
    while (offset + 4 <= extensionsEnd) {
      const type = (bytes[offset]! << 8) | bytes[offset + 1]!;
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
      offset += 4;
      if (type === 0) {
        let nameOffset = offset + 2;
        const listEnd = offset + length;
        while (nameOffset + 3 <= listEnd) {
          const nameLength = (bytes[nameOffset + 1]! << 8) | bytes[nameOffset + 2]!;
          if (bytes[nameOffset] === 0) {
            return Buffer.from(bytes.slice(nameOffset + 3, nameOffset + 3 + nameLength)).toString(
              "utf8",
            );
          }
          nameOffset += 3 + nameLength;
        }
      }
      offset += length;
    }
  } catch {
    return null;
  }
  return null;
}
