// A local proxy that reshapes WHEN bytes move, and changes nothing else.
//
//   pnpm cli voicelab wire --upstream https://os.iterate-preview-3.com --port 8899
//   pnpm cli voicelab wire --schedule /tmp/sched.json --port 8899
//
// Then point the C at it:
//   ITERATE_OS_BASE_URL=https://127.0.0.1:8899  iterate-kit-cli --insecure ...
//
// It serves TLS, because the client's transport always speaks TLS and always
// will: that adapter's value is that it is the code that ships, so the proxy
// bends to it rather than the other way round. The client already has an
// --insecure flag for exactly this, and it parses host:port, so nothing in
// the shipped C changes to put this in the path.
//
// WHY OUTSIDE THE PROCESS. The one seam whose adversary genuinely belongs to
// somebody else. `iterate_kit_posix_tls_stream` is a one-owner nonblocking
// OpenSSL adapter whose whole value is that connect, read and write each
// perform exactly one bounded transition and distinguish scheduler deferral
// from loss. Threading delay and stall knobs through it would mean the code
// under test is no longer the code that ships, in the module where that
// matters most.
//
// WHY ONLY TIMING. A TCP-level adversary cannot drop, duplicate or reorder an
// application frame: by the time bytes reach the adapter they are ordered,
// retransmitted and MAC-protected, so loss on the wire manifests as DELAY and
// never as a missing frame. Frame loss is the sender's behaviour and lives at
// the delivery boundary inside the client (`cli_delivery_fault`). Conflating
// the two is how a rig ends up "testing packet loss" while proving nothing
// about the only kind of loss this system actually suffers.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import tls from "node:tls";

/** Options for `pnpm cli voicelab wire`. */
export interface WireOptions {
  /** Where to really send the bytes. Defaults to APP_CONFIG_BASE_URL. */
  upstream?: string;
  /** Local port the C connects to. */
  port?: number;
  /** A schedule written by the C's --schedule-out; supplies every knob below. */
  schedule?: string;
  /** Downlink ceiling in frames per second; 9 was measured on the device. */
  throttleFps?: number;
  /** Stop moving bytes for this long, this often. */
  stallMs?: number;
  stallsPerMinute?: number;
}

/**
 * One 20 ms frame's worth of downlink bytes, as the throttle counts them.
 *
 * mu-law halves the payload, so a frame on the wire is ~320 bytes of audio
 * plus its event envelope. The exact number matters less than that the knob
 * is expressed in the same unit the device's own measurements were: "9 to 31
 * frames a second against the 50 realtime needs" is the fault being modelled.
 */
const BYTES_PER_FRAME = 420;
const DEFAULT_PORT = 8899;

interface Episode {
  kind: string;
  atMs: number;
  durationMs: number;
  magnitude: number;
}

/** Read the episodes the C drew, so both halves obey one artifact. */
function readSchedule(path: string): Episode[] {
  const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as { episodes?: Episode[] };
  return parsed.episodes ?? [];
}

/**
 * The reshaping itself: a token bucket for rate, a hard gate for stalls.
 *
 * Deliberately not a queue of timers. A timer per chunk reorders under load —
 * Node fires them in scheduling order, not enqueue order — and a proxy that
 * reorders TCP bytes is not modelling a network, it is corrupting a stream.
 * One chained promise keeps the bytes in the order they arrived, which is the
 * only ordering guarantee TCP actually gives.
 */
class Shaper {
  #tail: Promise<void> = Promise.resolve();
  #allowanceBytes = 0;
  #lastRefillMs = Date.now();

  constructor(
    private readonly bytesPerSecond: number,
    private readonly episodes: Episode[],
    private readonly startedMs: number,
  ) {}

  /** Milliseconds this chunk must wait before it may be forwarded. */
  #delayFor(bytes: number): number {
    const now = Date.now();
    const elapsed = now - this.startedMs;
    const stall = this.episodes.find(
      (e) =>
        (e.kind === "wire-stall" || e.kind === "wire-throttle") &&
        elapsed >= e.atMs &&
        elapsed < e.atMs + e.durationMs,
    );
    if (stall?.kind === "wire-stall") return stall.atMs + stall.durationMs - elapsed;
    if (this.bytesPerSecond <= 0) return 0;

    this.#allowanceBytes += ((now - this.#lastRefillMs) * this.bytesPerSecond) / 1000;
    this.#lastRefillMs = now;
    // One second of burst, so a throttle shapes the average without turning
    // every chunk into its own round trip.
    const ceiling = this.bytesPerSecond;
    if (this.#allowanceBytes > ceiling) this.#allowanceBytes = ceiling;
    this.#allowanceBytes -= bytes;
    if (this.#allowanceBytes >= 0) return 0;
    return (-this.#allowanceBytes / this.bytesPerSecond) * 1000;
  }

  /** Forward `chunk` when the shape allows, preserving arrival order. */
  send(chunk: Buffer, write: (data: Buffer) => void): void {
    const wait = this.#delayFor(chunk.length);
    this.#tail = this.#tail.then(async () => {
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      write(chunk);
    });
  }
}

/**
 * A throwaway certificate for 127.0.0.1, made once per machine.
 *
 * Self-signed and pinned to nothing: the client is told to skip verification
 * with its own --insecure flag, which exists so a lab can stand between the
 * device and the server. Written under the OS temp directory rather than the
 * repo so it can never be committed by accident.
 */
function ensureCertificate(): { cert: string; key: string } {
  const dir = path.join(os.tmpdir(), "iterate-voicelab-wire");
  const certPath = path.join(dir, "wire-cert.pem");
  const keyPath = path.join(dir, "wire-key.pem");
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "3650",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { stdio: "ignore" },
    );
  }
  return { cert: fs.readFileSync(certPath, "utf8"), key: fs.readFileSync(keyPath, "utf8") };
}

/**
 * Rewrite the Host header of the upgrade request.
 *
 * The client dials 127.0.0.1 and says so; the upstream is a Cloudflare
 * deployment that routes on Host and answers a request for "127.0.0.1" with
 * somebody else's worker or nothing at all. Everything after the upgrade is
 * opaque bytes this proxy never looks at again.
 */
function rewriteHost(head: Buffer, host: string): Buffer {
  const text = head.toString("latin1");
  const end = text.indexOf("\r\n\r\n");
  if (end === -1) return head;
  const headers = text
    .slice(0, end)
    .replace(/^Host:.*$/im, `Host: ${host}`)
    .replace(/^Origin:.*$/im, `Origin: https://${host}`);
  return Buffer.concat([Buffer.from(headers, "latin1"), Buffer.from(text.slice(end), "latin1")]);
}

export async function wire(options: WireOptions = {}) {
  const upstreamUrl = new URL(
    options.upstream ?? process.env.APP_CONFIG_BASE_URL?.trim() ?? "https://os.iterate.com",
  );
  const host = upstreamUrl.hostname;
  const port = options.port ?? DEFAULT_PORT;
  const episodes = options.schedule === undefined ? [] : readSchedule(options.schedule);
  const throttleFps =
    options.throttleFps ?? episodes.find((e) => e.kind === "wire-throttle")?.magnitude ?? 0;
  const bytesPerSecond = throttleFps * BYTES_PER_FRAME;

  const credentials = ensureCertificate();
  const server = tls.createServer(credentials, (client) => {
    const startedMs = Date.now();
    // Only the DOWNLINK is shaped. The uplink is the device talking, and the
    // device's own send path already has its own bounded queue and its own
    // accounting; shaping both would make an observed fault ambiguous.
    const down = new Shaper(bytesPerSecond, episodes, startedMs);
    let head: Buffer | null = Buffer.alloc(0);

    const upstream = tls.connect(
      { host, port: Number(upstreamUrl.port) || 443, servername: host },
      () => {},
    );
    upstream.on("data", (chunk: Buffer) => {
      down.send(chunk, (data) => {
        if (!client.destroyed) client.write(data);
      });
    });
    client.on("data", (chunk: Buffer) => {
      if (head !== null) {
        head = Buffer.concat([head, chunk]);
        if (head.indexOf("\r\n\r\n") === -1) return;
        upstream.write(rewriteHost(head, host));
        head = null;
        return;
      }
      upstream.write(chunk);
    });
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    client.on("close", close);
    upstream.on("error", close);
    upstream.on("close", close);
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`wire proxy 127.0.0.1:${String(port)} -> ${host}`);
  console.log(
    throttleFps > 0
      ? `  downlink held to ${String(throttleFps)} frames/second (the device measured 9-31)`
      : `  downlink unthrottled`,
  );
  console.log(
    `  ${String(episodes.filter((e) => e.kind === "wire-stall").length)} stalls scheduled`,
  );
  console.log(
    `\n  point the C at it:  ITERATE_OS_BASE_URL=https://127.0.0.1:${String(port)} --insecure\n`,
  );
  await new Promise(() => {}); // serve until killed
}
