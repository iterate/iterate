// context/fetch-upgrade-splice.ts — A LENT STUB'S WEBSOCKET THAT OUTLIVES ITS CONTEXT'S SOCKETS.
//
// A visitor's WebSocket to a lent rpc stub (a tunnel: `iterate tunnel 5173` serving Vite's HMR
// socket) rides two platform sockets that meet in the context Durable Object (rpc-stubs.ts, the
// fetch section): the EYEBALL socket (the edge ⇄ the DO) and the UPGRADE LEG (the /api relay ⇄ the
// DO). The DO forwards frames between them by upgradeId. Both are cut whenever the DO resets — every
// deploy resets every Durable Object for its new code — or the platform drops one (measured on prd
// 2026-09-24: a Vite HMR socket through a tunnel closed 1006 at every prd deploy, ~5 an hour, and
// once without one; the visitor's page then reloaded and lost its state).
//
// The two ends of those sockets are the platform's own stateless invocations — the edge holding the
// visitor's socket, the relay holding the provider's — and they outlive a DO reset (a deploy leaves
// running invocations on the version they started on). So each end is a `FetchUpgradeSpliceEnd`:
// it numbers the frames it sends, keeps them until the other end acknowledges them, and when its
// DO socket drops it dials the DO again under the same upgradeId, says what it has received
// (`resume`), and sends again what the other end has not. The visitor's and the provider's sockets
// never see the drop; nothing is lost or delivered twice.
//
// THE WIRE between the two ends (the DO forwards it untouched): every message is binary.
//   data   [1 text | 2 binary][seq: float64][payload — UTF-8 for text]
//   resume [3][received through: float64][1 = a reply, 0 = asks for one]
//   ack    [4][received through: float64]
//   close  [5][code: uint16][reason: UTF-8]
// `close` is the only orderly end: a DO socket that closes without one is a drop.
//
// BOUNDED: an end whose other end has not resumed within `FETCH_UPGRADE_RESUME_DEADLINE_MS` of the
// drop gives up and closes its own socket (1011): the other end is gone (a tunnel killed outright,
// its relay with it). Frames kept for the other end are capped (`FETCH_UPGRADE_UNACKED_MAX_BYTES`);
// past the cap the end gives up the same way.

/** How long an end keeps trying after its DO socket dropped: re-dials, then the other end's
 *  resume. A deploy's reset answers again within seconds (the rpc-stub pager's re-dial: 0.2–4 s
 *  on prd 2026-09-24). */
export const FETCH_UPGRADE_RESUME_DEADLINE_MS = 30_000;
/** The re-dials after a drop, their delays from the drop: the first at once. The deadline, counted
 *  from the first drop the other end has not resumed since, bounds them all. */
const REDIAL_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000];
/** Bytes of sent frames an end keeps for the other end until acknowledged. */
export const FETCH_UPGRADE_UNACKED_MAX_BYTES = 16 * 1024 * 1024;
/** An end acknowledges after this many frames received, or this many bytes, whichever comes first. */
const ACK_EVERY_FRAMES = 32;
const ACK_EVERY_BYTES = 256 * 1024;

const KIND = { text: 1, binary: 2, resume: 3, ack: 4, close: 5 } as const;

/** The socket an end holds — the runtime's WebSocket, and capnweb's tunneled one on the relay. */
export type SpliceSocket = {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", listener: (event: Event) => void): void;
};

/** What a socket event carries, read loosely: a message's `data`, a close's `code` and `reason`. */
type SocketEventFields = { data?: unknown; code?: number; reason?: string };

/** What an end reports, for the logs. */
export type FetchUpgradeSpliceEvent =
  | {
      type: "resumed";
      side: FetchUpgradeSide;
      upgradeId: string;
      downMs: number;
      dials: number;
      resent: number;
      /** the DO answered the re-dial on another deploy: a deploy's reset, expected */
      deployReset: boolean;
    }
  | {
      type: "gave-up";
      side: FetchUpgradeSide;
      upgradeId: string;
      downMs: number;
      dials: number;
      why: string;
    };

type FetchUpgradeSide = "eyeball" | "leg";

/** A re-dial's answer: the DO socket, open, and the deploy that answered it. */
type Redialed = { socket: SpliceSocket; deployId: string | null };

/** One end of a spliced upgrade (the file header). */
export class FetchUpgradeSpliceEnd {
  readonly #side: FetchUpgradeSide;
  readonly #upgradeId: string;
  readonly #local: SpliceSocket;
  readonly #redial: () => Promise<Redialed | null>;
  readonly #report: (event: FetchUpgradeSpliceEvent) => void;

  /** The DO socket in service, null while re-dialing. */
  #socket: SpliceSocket | null = null;
  /** The deploy the DO socket was answered on: a re-dial answered on another is a deploy's reset. */
  #deployId: string | null;
  #ended = false;

  // SENDING: the last sequence number used, and every data frame the other end has not acknowledged.
  #sentThrough = 0;
  readonly #unacked: { seq: number; frame: ArrayBuffer }[] = [];
  #unackedBytes = 0;

  // RECEIVING: the last sequence number delivered to the local socket, and what is not yet acknowledged.
  #receivedThrough = 0;
  #receivedSinceAck = 0;
  #bytesSinceAck = 0;

  // A DROP IN PROGRESS: since when, how many dials, and the deadline for the other end's resume.
  #downSince: number | null = null;
  #dials = 0;
  #deadline: ReturnType<typeof setTimeout> | null = null;

  constructor(input: {
    side: FetchUpgradeSide;
    upgradeId: string;
    /** The socket this end serves: the visitor's (the edge) or the provider's (the relay). Frames
     *  on it are the application's, untouched. */
    local: SpliceSocket;
    /** The first DO socket, and the deploy it was answered on. */
    socket: SpliceSocket;
    deployId: string | null;
    /** Dial the DO for this side again: an open socket, or null when it answered no socket. */
    redial: () => Promise<Redialed | null>;
    report: (event: FetchUpgradeSpliceEvent) => void;
  }) {
    this.#side = input.side;
    this.#upgradeId = input.upgradeId;
    this.#local = input.local;
    this.#redial = input.redial;
    this.#report = input.report;
    this.#deployId = input.deployId;
    // an Event subtype per `type`: a MessageEvent's `data`, a CloseEvent's `code` and `reason`
    preferArrayBuffers(this.#local);
    this.#local.addEventListener("message", (event) =>
      this.#inOrder((event as SocketEventFields).data, (data) => this.#sendData(data)),
    );
    this.#local.addEventListener("close", (event) => {
      const { code, reason } = event as SocketEventFields;
      this.#endLocally(code, reason);
    });
    this.#local.addEventListener("error", () => this.#endLocally(1011, "the socket failed"));
    // The first socket waits for the other end exactly as a re-dialed one does: the relay's leg is
    // up before the edge's socket exists, and neither end may wait forever.
    this.#downSince = Date.now();
    this.#armDeadline();
    this.#attach(input.socket);
  }

  /** Messages from either socket, handled in the order they arrived: a binary one the runtime
   *  hands over as a Blob (a socket whose `binaryType` is "blob") is read first, and every message
   *  after it waits its turn. */
  #pending: Promise<void> | null = null;
  #inOrder(data: unknown, handle: (data: unknown) => void): void {
    if (!this.#pending && !(data instanceof Blob)) return handle(data);
    const previous = this.#pending || Promise.resolve();
    const next = previous
      .then(async () => handle(data instanceof Blob ? await data.arrayBuffer() : data))
      .catch(() => undefined)
      .finally(() => {
        if (this.#pending === next) this.#pending = null;
      });
    this.#pending = next;
  }

  // ── the local socket ──

  #sendData(data: unknown): void {
    if (this.#ended || this.#closeFrame) return;
    const payload =
      typeof data === "string"
        ? { kind: KIND.text, bytes: new TextEncoder().encode(data) }
        : { kind: KIND.binary, bytes: bytesOf(data) };
    if (!payload.bytes) return;
    const seq = ++this.#sentThrough;
    const frame = new Uint8Array(9 + payload.bytes.byteLength);
    frame[0] = payload.kind;
    new DataView(frame.buffer).setFloat64(1, seq);
    frame.set(payload.bytes, 9);
    this.#unacked.push({ seq, frame: frame.buffer });
    this.#unackedBytes += frame.byteLength;
    if (this.#unackedBytes > FETCH_UPGRADE_UNACKED_MAX_BYTES) {
      this.#giveUp(
        `more than ${FETCH_UPGRADE_UNACKED_MAX_BYTES} bytes sent and not acknowledged by the other end`,
      );
      return;
    }
    this.#sendOnSocket(frame.buffer);
  }

  /** The local socket closed: the orderly end, said to the other end in-band — once the splice is
   *  whole, after everything sent before it. While the DO socket is down it waits for the resume. */
  #endLocally(code: number | undefined, reason: string | undefined): void {
    if (this.#ended || this.#closeFrame) return;
    const reasonBytes = new TextEncoder().encode(truncateCloseReason(reason || ""));
    const frame = new Uint8Array(3 + reasonBytes.byteLength);
    frame[0] = KIND.close;
    new DataView(frame.buffer).setUint16(1, sendableCloseCode(code));
    frame.set(reasonBytes, 3);
    this.#closeFrame = frame.buffer;
    if (this.#downSince === null) this.#sendClose();
  }

  /** The local socket's close, owed to the other end until the splice is whole (`#endLocally`). */
  #closeFrame: ArrayBuffer | null = null;

  #sendClose(): void {
    this.#ended = true;
    this.#clearDeadline();
    this.#sendOnSocket(this.#closeFrame!);
    closeQuietly(this.#socket, 1000, "closed");
    this.#socket = null;
  }

  // ── the DO socket ──

  #attach(socket: SpliceSocket): void {
    this.#socket = socket;
    preferArrayBuffers(socket);
    socket.addEventListener("message", (event) => {
      // a MessageEvent: its `data`
      this.#inOrder((event as SocketEventFields).data, (data) => {
        if (this.#socket === socket) this.#receive(data);
      });
    });
    const dropped = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      if (!this.#ended) void this.#redialAfterDrop();
    };
    socket.addEventListener("close", dropped);
    socket.addEventListener("error", dropped);
    // Say what this end has received: the other end sends the rest, and answers with its own.
    this.#sendOnSocket(controlFrame(KIND.resume, this.#receivedThrough, 0));
  }

  #receive(data: unknown): void {
    if (this.#ended) return;
    const bytes = bytesOf(data);
    if (!bytes || bytes.byteLength < 1) return; // not this wire's: nothing an end sends
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const kind = bytes[0];
    if (kind === KIND.text || kind === KIND.binary) {
      if (bytes.byteLength < 9) return;
      const seq = view.getFloat64(1);
      // A frame already delivered is a resend; one past the next is a live frame that overtook the
      // resend of an earlier one — it is resent in its turn, since the other end keeps it.
      if (seq !== this.#receivedThrough + 1) return;
      this.#receivedThrough = seq;
      const payload = bytes.subarray(9);
      try {
        this.#local.send(
          kind === KIND.text ? new TextDecoder().decode(payload) : payload.slice().buffer,
        );
      } catch {
        /* the local socket is closing: its close ends this end */
      }
      this.#receivedSinceAck += 1;
      this.#bytesSinceAck += bytes.byteLength;
      if (this.#receivedSinceAck >= ACK_EVERY_FRAMES || this.#bytesSinceAck >= ACK_EVERY_BYTES)
        this.#acknowledge();
      return;
    }
    if (kind === KIND.ack) {
      if (bytes.byteLength >= 9) this.#forgetThrough(view.getFloat64(1));
      return;
    }
    if (kind === KIND.resume) {
      if (bytes.byteLength < 10) return;
      this.#forgetThrough(view.getFloat64(1));
      for (const { frame } of this.#unacked) this.#sendOnSocket(frame);
      if (bytes[9] === 0) this.#sendOnSocket(controlFrame(KIND.resume, this.#receivedThrough, 1));
      this.#resumed();
      if (this.#closeFrame) this.#sendClose();
      return;
    }
    if (kind === KIND.close) {
      if (bytes.byteLength < 3) return;
      const code = view.getUint16(1);
      const reason = new TextDecoder().decode(bytes.subarray(3));
      this.#ended = true;
      this.#clearDeadline();
      closeQuietly(this.#local, sendableCloseCode(code), reason);
      closeQuietly(this.#socket, 1000, "closed");
      this.#socket = null;
    }
  }

  #acknowledge(): void {
    this.#receivedSinceAck = 0;
    this.#bytesSinceAck = 0;
    this.#sendOnSocket(controlFrame(KIND.ack, this.#receivedThrough));
  }

  #forgetThrough(seq: number): void {
    while (this.#unacked.length > 0 && this.#unacked[0]!.seq <= seq) {
      this.#unackedBytes -= this.#unacked.shift()!.frame.byteLength;
    }
  }

  #sendOnSocket(frame: ArrayBuffer): void {
    try {
      this.#socket?.send(frame);
    } catch {
      /* the DO socket is closing: its close starts the re-dial, and the frame is still kept */
    }
  }

  // ── a drop: re-dial, then the other end's resume ──

  /** The other end resumed: the splice is whole again. The first resume after the first socket is
   *  the start, not a recovery — nothing to report. */
  #resumed(): void {
    if (this.#downSince === null) return;
    const downMs = Date.now() - this.#downSince;
    const recovered = this.#dials > 0;
    this.#clearDeadline();
    this.#downSince = null;
    if (recovered)
      this.#report({
        type: "resumed",
        side: this.#side,
        upgradeId: this.#upgradeId,
        downMs,
        dials: this.#dials,
        resent: this.#unacked.length,
        deployReset: this.#deployReset,
      });
    this.#dials = 0;
    this.#deployReset = false;
  }

  /** Whether a re-dial of this drop was answered on another deploy than the socket it replaced. */
  #deployReset = false;

  async #redialAfterDrop(): Promise<void> {
    if (this.#downSince === null) {
      this.#downSince = Date.now();
      this.#armDeadline();
    }
    const droppedAt = Date.now();
    for (const delayMs of REDIAL_DELAYS_MS) {
      const wait = droppedAt + delayMs - Date.now();
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
      if (this.#ended || this.#socket) return;
      this.#dials += 1;
      let dialed: Redialed | null;
      try {
        dialed = await this.#redial();
      } catch {
        continue; // the DO did not answer (a reset in progress): the next try
      }
      if (!dialed) continue;
      if (this.#ended) {
        closeQuietly(dialed.socket, 1000, "closed");
        return;
      }
      if (dialed.deployId !== this.#deployId) this.#deployReset = true;
      this.#deployId = dialed.deployId;
      this.#attach(dialed.socket);
      return;
    }
    // every try failed; the deadline ends it
  }

  #armDeadline(): void {
    this.#clearDeadline();
    const downSince = this.#downSince!;
    this.#deadline = setTimeout(
      () => {
        this.#deadline = null;
        if (this.#downSince === downSince)
          this.#giveUp(
            `the other end did not resume within ${FETCH_UPGRADE_RESUME_DEADLINE_MS / 1000} s`,
          );
      },
      downSince + FETCH_UPGRADE_RESUME_DEADLINE_MS - Date.now(),
    );
  }

  #clearDeadline(): void {
    if (this.#deadline !== null) clearTimeout(this.#deadline);
    this.#deadline = null;
  }

  #giveUp(why: string): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#clearDeadline();
    this.#report({
      type: "gave-up",
      side: this.#side,
      upgradeId: this.#upgradeId,
      downMs: this.#downSince === null ? 0 : Date.now() - this.#downSince,
      dials: this.#dials,
      why,
    });
    closeQuietly(this.#local, 1011, truncateCloseReason(why));
    closeQuietly(this.#socket, 1011, "gave up");
    this.#socket = null;
  }
}

/** Binary messages as ArrayBuffers where the socket lets us choose (the runtime's `binaryType`). */
function preferArrayBuffers(socket: SpliceSocket): void {
  if ("binaryType" in socket) (socket as { binaryType: string }).binaryType = "arraybuffer";
}

function controlFrame(kind: number, seq: number, reply?: 0 | 1): ArrayBuffer {
  const frame = new Uint8Array(reply === undefined ? 9 : 10);
  frame[0] = kind;
  new DataView(frame.buffer).setFloat64(1, seq);
  if (reply !== undefined) frame[9] = reply;
  return frame.buffer;
}

/** A binary message's bytes (an ArrayBuffer, a view of one, a Node Buffer), or null for anything else. */
function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function closeQuietly(socket: SpliceSocket | null, code: number, reason: string): void {
  try {
    socket?.close(code, reason);
  } catch {
    /* already closing */
  }
}

/** A close code a socket may send: the ones only a runtime reports (1005 none, 1006 abnormal, 1015
 *  TLS) and anything out of range become 1000. */
function sendableCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if (code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014))
    return code;
  return code >= 3000 && code <= 4999 ? code : 1000;
}

/** A close reason within the RFC's 123 UTF-8 bytes (workerd throws past it), whole characters. */
function truncateCloseReason(reason: string): string {
  let out = reason;
  while (new TextEncoder().encode(out).length > 123) out = out.slice(0, -1);
  return out;
}

/** THE LOG LINE for what an end reports. A resume after a deploy's reset is expected on every deploy
 *  under traffic (info); one without a deploy healed a platform failure (the prd fault alarm pages on
 *  a burst of `platform-failure` heals). Giving up is the other end gone — a tunnel killed outright,
 *  a laptop asleep — or a platform failure that outlasted the deadline: a warn, with its reason. */
export function reportFetchUpgradeSpliceEvent(event: FetchUpgradeSpliceEvent): void {
  const { type, side, ...fields } = event;
  if (type === "gave-up") {
    console.warn({
      event: "fetch-upgrade.resume-gave-up",
      name: `fetch-upgrade-${side}`,
      message: "a resumable upgrade's other end did not come back: its socket is closed",
      ...fields,
    });
    return;
  }
  if (event.deployReset)
    console.info({
      event: "fetch-upgrade.deploy-reset-resumed",
      name: `fetch-upgrade-${side}`,
      message: "a deploy reset the context's sockets; the upgrade resumed",
      ...fields,
    });
  else
    console.warn({
      event: "fetch-upgrade.platform-failure-resumed",
      name: `fetch-upgrade-${side}`,
      message: "a context's socket dropped without a deploy; the upgrade resumed",
      ...fields,
    });
}
