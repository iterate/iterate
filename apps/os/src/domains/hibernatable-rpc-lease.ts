// A private compatibility layer for RPC references that cannot yet survive a
// Durable Object hibernation boundary.
//
// The logical owner and the expensive Durable Object are connected by two
// deliberately different legs:
//
//   stateless Worker -- hibernatable WebSocket --> Durable Object
//   Durable Object -- transient provider-object RPC stub --> stateless Worker
//
// The socket carries only addressed lifecycle frames (`wake`, `idle`, and
// lane-specific retirement) plus a serialized attachment. The stateless relay
// may cache an ordinary Durable Object stub; that stub is not itself a pin.
// Only while handling an invocation burst does the Durable Object retain an
// inbound provider-object stub pointing back into the stateless relay.
//
// This is intentionally shaped as an emulation of the native model Kenton
// Varda describes, not as a public WebSocket API:
//
// - https://github.com/cloudflare/capnweb/issues/36#issuecomment-4040638107
//   describes terminating Cap'n Web in a stateless Worker, using ordinary
//   Workers RPC into the Durable Object, and eventually storing recreatable
//   inbound targets / outbound stubs across hibernation.
// - https://github.com/cloudflare/workerd/issues/6087#issuecomment-3962391382
//   says that native support is planned, tentatively; no current Workers API
//   provides hibernatable RpcTargets or persistent outbound stubs.
//
// When that runtime support exists, callers should keep the same logical
// lease and provider interfaces; only this transport and the short-leg
// adapters should disappear.

import { z } from "zod";

export type HibernatableRpcLeaseBinding = {
  leaseKey: string;
  socketId: string;
};

const HibernatableRpcLeaseFrame = z.union([
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("wake") }),
]);

export type HibernatableRpcLeaseFrame = z.infer<typeof HibernatableRpcLeaseFrame>;

export type HibernatableRpcLeaseSocketEntry<Attachment> = {
  attachment: Attachment;
  binding: HibernatableRpcLeaseBinding;
  ws: WebSocket;
};

type HibernatableRpcLeaseSocketHooks = {
  acceptWebSocket(ws: WebSocket, tags: string[]): void;
  getWebSockets(tag: string): WebSocket[];
};

type HibernatableRpcLeaseSocketsOptions<Attachment> = {
  attachmentSchema: z.ZodType<Attachment>;
  bindingOf(attachment: Attachment): HibernatableRpcLeaseBinding;
  createAttachment(binding: HibernatableRpcLeaseBinding): Attachment;
  headerName: string;
  hooks: HibernatableRpcLeaseSocketHooks;
  lane: string;
  socketTag: string;
  upgradeSchema: z.ZodType<HibernatableRpcLeaseBinding>;
};

/** Decode one lifecycle frame. Unknown or malformed frames are dropped whole. */
export function parseHibernatableRpcLeaseFrame(
  data: unknown,
): HibernatableRpcLeaseFrame | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = HibernatableRpcLeaseFrame.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Durable-Object half of a hibernatable RPC lease.
 *
 * The attachment codec is injected so an established lane can preserve its
 * exact on-wire durable shape through hibernation and in-place runtime
 * reconstruction. Deployments terminate WebSockets; the lane must treat that
 * as terminal and reconcile its durable records. This class owns
 * the transport invariants: only marked upgrades are accepted, every socket
 * is accepted through the hibernation API, attachments are validated before
 * use, one exact socket claims a lease key, and any serialization/send failure
 * closes the channel so it cannot remain healthy-looking and stale.
 */
export class HibernatableRpcLeaseSockets<
  Attachment,
  Frame extends { type: string } = HibernatableRpcLeaseFrame,
> {
  readonly #options: HibernatableRpcLeaseSocketsOptions<Attachment>;

  constructor(options: HibernatableRpcLeaseSocketsOptions<Attachment>) {
    this.#options = options;
  }

  /** Accept the relay's internal WebSocket upgrade through the DO's real fetch(). */
  acceptUpgrade(request: Request): Response {
    const rawHeader = request.headers.get(this.#options.headerName);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket" || rawHeader === null) {
      return Response.json(
        { error: `${this.#options.lane} accepts only hibernatable RPC lease upgrades` },
        { status: 400 },
      );
    }

    let rawBinding: unknown;
    try {
      rawBinding = JSON.parse(rawHeader);
    } catch (error) {
      return Response.json(
        {
          error: `invalid ${this.#options.headerName} header: ${error instanceof Error ? error.message : String(error)}`,
        },
        { status: 400 },
      );
    }
    const binding = this.#options.upgradeSchema.safeParse(rawBinding);
    if (!binding.success) {
      return Response.json(
        { error: `invalid ${this.#options.headerName} header: ${binding.error.message}` },
        { status: 400 },
      );
    }

    const pair = new WebSocketPair();
    this.#options.hooks.acceptWebSocket(pair[1], [this.#options.socketTag]);
    try {
      pair[1].serializeAttachment(this.#options.createAttachment(binding.data));
    } catch (error) {
      this.close(pair[1], 1011, "initial attachment stamp failed");
      console.error(`${this.#options.lane} initial attachment stamp failed`, { error });
      return Response.json(
        { error: `${this.#options.lane} attachment stamp failed` },
        { status: 500 },
      );
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Every accepted socket whose attachment still validates. */
  entries(leaseKey?: string): HibernatableRpcLeaseSocketEntry<Attachment>[] {
    const entries: HibernatableRpcLeaseSocketEntry<Attachment>[] = [];
    for (const ws of this.#options.hooks.getWebSockets(this.#options.socketTag)) {
      const attachment = this.attachment(ws);
      if (attachment === undefined) continue;
      const binding = this.#options.bindingOf(attachment);
      if (leaseKey !== undefined && binding.leaseKey !== leaseKey) continue;
      entries.push({ attachment, binding, ws });
    }
    return entries;
  }

  /** Read and validate one socket's durable attachment. */
  attachment(ws: WebSocket): Attachment | undefined {
    let raw: unknown;
    try {
      raw = ws.deserializeAttachment();
    } catch {
      return undefined;
    }
    const parsed = this.#options.attachmentSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * Claim the caller's exact socket and close every same-key loser. This is
   * the last-writer-wins boundary that prevents two logical owners from
   * alternating wake/rebind forever.
   */
  claim(
    binding: HibernatableRpcLeaseBinding,
  ): HibernatableRpcLeaseSocketEntry<Attachment> | undefined {
    let claimed: HibernatableRpcLeaseSocketEntry<Attachment> | undefined;
    for (const entry of this.entries(binding.leaseKey)) {
      if (entry.binding.socketId === binding.socketId) {
        if (claimed !== undefined) this.close(claimed.ws, 1000, "superseded");
        claimed = entry;
      } else {
        this.close(entry.ws, 1000, "superseded");
      }
    }
    return claimed;
  }

  /**
   * Replace a socket's attachment; failure closes it and returns false.
   * Cloudflare caps serialized WebSocket attachments at 16 KiB, so lanes must
   * keep this control-plane state bounded and leave population in durable
   * records rather than embedding a logical-lease directory here.
   */
  stamp(ws: WebSocket, attachment: Attachment): boolean {
    try {
      ws.serializeAttachment(attachment);
      return true;
    } catch (error) {
      console.warn(`${this.#options.lane} attachment stamp failed; closing lease socket`, {
        binding: this.#options.bindingOf(attachment),
        error,
      });
      this.close(ws, 1011, "attachment stamp failed");
      return false;
    }
  }

  /** Send one lifecycle frame; failure closes the channel and returns false. */
  send(ws: WebSocket, frame: Frame): boolean {
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      console.warn(`${this.#options.lane} ${frame.type} frame failed; closing lease socket`, {
        error,
      });
      this.close(ws, 1011, `${frame.type} frame failed`);
      return false;
    }
  }

  /** Close one lease channel without allowing an already-closing socket to escape. */
  close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  /** A socket error is terminal: log it, then close so its owner can recover. */
  handleError(ws: WebSocket, error: unknown): void {
    console.error(`${this.#options.lane} lease socket error`, { error });
    this.close(ws, 1011, "websocket error");
  }
}

/** Dial the hibernatable half of a lease through a Durable Object's real fetch(). */
export async function openHibernatableRpcLeaseSocket(input: {
  headerName: string;
  headerValue: unknown;
  stub: { fetch(request: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  url: string;
}): Promise<WebSocket> {
  const upgrade = await input.stub.fetch(input.url, {
    headers: {
      Upgrade: "websocket",
      [input.headerName]: JSON.stringify(input.headerValue),
    },
  });
  const socket = upgrade.webSocket;
  if (socket === null) {
    throw new Error(
      `hibernatable RPC lease upgrade returned ${upgrade.status} without a WebSocket`,
    );
  }
  socket.accept();
  return socket;
}
