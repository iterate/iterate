// Hibernatable Pagers: client-supplied return channels that let a Durable
// Object release ordinary RPC references while idle and contact the client
// relay again when work appears.
//
// The client gives the DO a WebSocket and says: "I may no longer be resident;
// page me here if you need me." The two directions are deliberately different:
//
//   client relay -- gives hibernatable Pager --> Durable Object
//   Durable Object -- sends one-way Page -----> client relay
//   client relay -- lends transient RPC leg --> Durable Object (when needed)
//
// A Pager is not an RPC connection and is not application truth. Its bounded
// serialized attachment is only the lane's hibernation-safe return address.
// Pages are best-effort; each lane recovers correctness from its own durable
// events, state, cursor, or current socket inventory.
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
// When that runtime support exists, callers should keep their domain
// interfaces; only the Pager and transient-leg adapters should disappear.

import { z } from "zod";

type HibernatablePagerBinding = {
  pagerId: string;
  pagerKey: string;
};

type HibernatablePagerSocketEntry<Attachment> = {
  attachment: Attachment;
  binding: HibernatablePagerBinding;
  ws: WebSocket;
};

type HibernatablePagerSocketHooks = {
  acceptWebSocket(ws: WebSocket, tags: string[]): void;
  getWebSockets(tag: string): WebSocket[];
};

type HibernatablePagersOptions<Attachment> = {
  attachmentSchema: z.ZodType<Attachment>;
  bindingOf(attachment: Attachment): HibernatablePagerBinding;
  createAttachment(binding: HibernatablePagerBinding): Attachment;
  headerName: string;
  hooks: HibernatablePagerSocketHooks;
  lane: string;
  pagerTag: string;
  upgradeSchema: z.ZodType<HibernatablePagerBinding>;
};

/** Decode one lane-owned Page. Unknown or malformed messages are dropped whole. */
export function parseHibernatablePage<Page>(
  data: unknown,
  schema: z.ZodType<Page>,
): Page | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Durable-Object registry for one Pager lane.
 *
 * The attachment codec is injected so an established lane can preserve its
 * exact on-wire durable shape through hibernation and in-place runtime
 * reconstruction. Deployments terminate WebSockets; the lane must treat that
 * as terminal and reconcile its durable records. This class owns
 * the transport invariants: only marked upgrades are accepted, every socket
 * is accepted through the hibernation API, attachments are validated before
 * use, one exact Pager claims a key, and any serialization/Page failure closes
 * the channel so it cannot remain healthy-looking and stale.
 */
export class HibernatablePagers<Attachment> {
  readonly #options: HibernatablePagersOptions<Attachment>;

  constructor(options: HibernatablePagersOptions<Attachment>) {
    this.#options = options;
  }

  /** Accept the relay's internal WebSocket upgrade through the DO's real fetch(). */
  acceptUpgrade(request: Request): Response {
    const rawHeader = request.headers.get(this.#options.headerName);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket" || rawHeader === null) {
      return Response.json(
        { error: `${this.#options.lane} accepts only hibernatable Pager upgrades` },
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
    this.#options.hooks.acceptWebSocket(pair[1], [this.#options.pagerTag]);
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
  entries(pagerKey?: string): HibernatablePagerSocketEntry<Attachment>[] {
    const entries: HibernatablePagerSocketEntry<Attachment>[] = [];
    for (const ws of this.#options.hooks.getWebSockets(this.#options.pagerTag)) {
      // getWebSockets() may retain a locally closed socket while its close
      // handshake is still in progress. It no longer owns a usable Pager.
      if (ws.readyState !== WebSocket.OPEN) continue;
      const attachment = this.attachment(ws);
      if (attachment === undefined) continue;
      const binding = this.#options.bindingOf(attachment);
      if (pagerKey !== undefined && binding.pagerKey !== pagerKey) continue;
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
  claim(binding: HibernatablePagerBinding): HibernatablePagerSocketEntry<Attachment> | undefined {
    let claimed: HibernatablePagerSocketEntry<Attachment> | undefined;
    for (const entry of this.entries(binding.pagerKey)) {
      if (entry.binding.pagerId === binding.pagerId) {
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
   * records rather than embedding a logical-interest directory here.
   */
  stamp(ws: WebSocket, attachment: Attachment): boolean {
    try {
      ws.serializeAttachment(attachment);
      return true;
    } catch (error) {
      console.warn(`${this.#options.lane} attachment stamp failed; closing Pager`, {
        binding: this.#options.bindingOf(attachment),
        error,
      });
      this.close(ws, 1011, "attachment stamp failed");
      return false;
    }
  }

  /** Send one lane-owned Page; failure closes the Pager and returns false. */
  page(ws: WebSocket, page: unknown): boolean {
    try {
      ws.send(JSON.stringify(page));
      return true;
    } catch (error) {
      console.warn(`${this.#options.lane} Page failed; closing Pager`, {
        page,
        error,
      });
      this.close(ws, 1011, "Page failed");
      return false;
    }
  }

  /** Close one Pager without allowing an already-closing socket to escape. */
  close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  /** A socket error is terminal: log it, then close so its owner can recover. */
  handleError(ws: WebSocket, error: unknown): void {
    console.error(`${this.#options.lane} Pager error`, { error });
    this.close(ws, 1011, "websocket error");
  }
}

/** Give a Durable Object a Hibernatable Pager through its real fetch(). */
export async function dialHibernatablePager(input: {
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
    throw new Error(`hibernatable Pager upgrade returned ${upgrade.status} without a WebSocket`);
  }
  socket.accept();
  return socket;
}
