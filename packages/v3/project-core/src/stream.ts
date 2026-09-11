import { z } from "zod";
import { EventInput, Json, canonical, verifyEvent, type EventRecord } from "./signatures.ts";
import { Fault, Mount, Processor, Read, Trust } from "./model.ts";

const Setting = z.strictObject({ key: z.string().min(1).max(160), value: Json });
const Ack = z.strictObject({ afterOffset: z.number().int().nonnegative() });
type StoredEnvelope = Omit<EventRecord, "offset">;
type SocketProgress = {
  kind: "stream";
  afterOffset: number;
  throughOffset: number;
  deadline: number | null;
};
export type StreamApplication = (record: EventRecord) => void;
type Prepared = {
  input: EventInput;
  signerKeyIds: readonly string[];
  apply?: StreamApplication;
};

/** One synchronous transaction is the write seam. No mutex, async reducer or second log. */
export class Stream {
  readonly sql: SqlStorage;
  constructor(
    readonly ctx: DurableObjectState,
    readonly name: string,
  ) {
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS events (offset INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, input TEXT NOT NULL, record TEXT NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, offset INTEGER NOT NULL)",
    );
  }

  setting(key: string) {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)
      .toArray()[0];
    return row ? Json.parse(JSON.parse(row.value)) : null;
  }

  settings() {
    return this.sql
      .exec<{ key: string; value: string; offset: number }>("SELECT * FROM settings ORDER BY key")
      .toArray()
      .map((row) => ({ ...row, value: Json.parse(JSON.parse(row.value)) }));
  }

  get head() {
    return this.sql
      .exec<{ head: number }>("SELECT coalesce(max(offset), 0) AS head FROM events")
      .one().head;
  }

  async prepare(
    value: unknown,
    prepareApplication: (event: EventInput) => Promise<Prepared["apply"]>,
  ) {
    const input = EventInput.parse(value);
    if (input.type.startsWith("itx.system."))
      throw new Fault("RESERVED", "Platform facts cannot be supplied by callers");
    if (input.type === "itx.set") {
      const { key, value: setting } = Setting.parse(input.data);
      if (key === "trust") Trust.parse(setting);
      if (key === "egress" || key === "mount/app")
        throw new Fault("FETCH_POLICY", "Routing belongs in the single mount/fetch policy");
      if (key.startsWith("mount/")) {
        Mount.parse({ match: key.slice(6), target: setting });
        if (key === "mount/builtins" || key.startsWith("mount/builtins."))
          throw new Fault("RESERVED", "Physical builtins cannot be replaced");
      }
      if (key.startsWith("processor/") && setting !== null) Processor.parse(setting);
    }
    // Crypto is asynchronous. Trust is deliberately decided synchronously at the commit point.
    const signerKeyIds = await verifyEvent(this.name, input);
    return { input, signerKeyIds, apply: await prepareApplication(input) } satisfies Prepared;
  }

  commit(prepared: Prepared[], platform = false) {
    return this.ctx.storage.transactionSync(() => this.#commit(prepared, platform));
  }

  /** Egress invokes this only from its already-open storage transaction. */
  platformAppend(input: EventInput) {
    const parsed = EventInput.parse(input);
    if (!parsed.type.startsWith("itx.system."))
      throw new Fault("RESERVED", "Platform writes must identify their origin");
    return this.#commit([{ input: parsed, signerKeyIds: [] }], true)[0];
  }

  #commit(prepared: Prepared[], platform: boolean) {
    // Call-local: Stream alone writes trust, advancing this row after each actual policy change.
    let policy = this.sql
      .exec<{ value: string; offset: number }>(
        "SELECT value, offset FROM settings WHERE key = 'trust'",
      )
      .toArray()[0];
    return prepared.map(({ input, signerKeyIds, apply }) => {
      const serialized = canonical(input);
      const existing = this.sql
        .exec<{ offset: number; input: string; record: string }>(
          "SELECT offset, input, record FROM events WHERE id = ?",
          input.id,
        )
        .toArray()[0];
      if (existing) {
        if (existing.input !== serialized)
          throw new Fault("ID_CONFLICT", "Event id already names different content", 409);
        // Rows contain verified envelopes; SQLite supplies the offset, including for older rows.
        return {
          ...(JSON.parse(existing.record) as StoredEnvelope),
          offset: existing.offset,
        };
      }
      const trust = Trust.parse(policy ? JSON.parse(policy.value) : { keys: [], minLevel: 0 });
      const signers = signerKeyIds.map((keyId) => ({
        keyId,
        trusted: trust.keys.includes(keyId),
      }));
      const level = signers.some((signer) => signer.trusted) ? 2 : signers.length ? 1 : 0;
      const acceptedSigners =
        trust.minLevel === 2 ? signers.filter((signer) => signer.trusted).length : signers.length;
      if (
        !platform &&
        (level < trust.minLevel || (trust.minLevel > 0 && acceptedSigners < trust.minSigners))
      )
        throw new Fault(
          "SIGNATURE_REQUIRED",
          `This context requires ${trust.minSigners} signatures at level ${trust.minLevel}`,
          403,
        );
      if (platform && !input.type.startsWith("itx.system."))
        throw new Fault("RESERVED", "Platform writes must identify their origin");
      const record = {
        ...input,
        context: this.name,
        time: Date.now(),
        verification: { signers, level, policyOffset: policy?.offset ?? 0 },
      } satisfies StoredEnvelope;
      // SQLite owns the offset; do not rewrite every envelope merely to duplicate its row key.
      const { offset } = this.sql
        .exec<{ offset: number }>(
          "INSERT INTO events(id,input,record) VALUES (?,?,?) RETURNING offset",
          input.id,
          serialized,
          JSON.stringify(record),
        )
        .one();
      const stored = { ...record, offset };
      apply?.(stored);
      if (input.type === "itx.set") {
        const setting = Setting.parse(input.data);
        this.sql.exec(
          "INSERT INTO settings VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,offset=excluded.offset",
          setting.key,
          JSON.stringify(setting.value),
          offset,
        );
        if (setting.key === "trust") policy = { value: JSON.stringify(setting.value), offset };
      }
      return stored;
    });
  }

  readEvents(options: unknown = {}) {
    const { afterOffset, limit } = Read.parse(options);
    const head = this.head;
    const events: EventRecord[] = [];
    let bytes = 0;
    for (const row of this.sql.exec<{ offset: number; record: string }>(
      "SELECT offset, record FROM events WHERE offset > ? ORDER BY offset LIMIT ?",
      afterOffset,
      limit,
    )) {
      // Stored rows are produced exclusively by commit; no untrusted metadata enters this column.
      const record = {
        ...(JSON.parse(row.record) as StoredEnvelope),
        offset: row.offset,
      };
      bytes += new TextEncoder().encode(JSON.stringify(record)).byteLength;
      if (bytes > 262144 && events.length) break;
      events.push(record);
    }
    return {
      events,
      afterOffset: Math.min(afterOffset, head),
      throughOffset: events.at(-1)?.offset ?? Math.min(afterOffset, head),
      head,
    };
  }

  subscribe(request: Request) {
    this.expireAcknowledgements();
    if (
      this.ctx.getWebSockets("stream").filter((socket) => socket.readyState === WebSocket.OPEN)
        .length >= 64
    )
      throw new Fault("SUBSCRIBERS", "Context already has 64 live subscriptions", 429);
    const afterOffset = Number(new URL(request.url).searchParams.get("afterOffset") ?? 0);
    Ack.parse({ afterOffset });
    if (afterOffset > this.head)
      throw new Fault("OFFSET", "Subscription cursor is beyond the current head", 409);
    const pair = new WebSocketPair();
    const progress: SocketProgress = {
      kind: "stream",
      afterOffset,
      throughOffset: afterOffset,
      deadline: null,
    };
    pair[1].serializeAttachment(progress);
    this.ctx.acceptWebSocket(pair[1], ["stream"]);
    this.send(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  send(socket: WebSocket) {
    // This tag belongs only to subscribe(), which persists this exact attachment shape.
    const progress = socket.deserializeAttachment() as SocketProgress;
    if (progress.deadline !== null || socket.readyState !== WebSocket.OPEN) return;
    const page = this.readEvents({ afterOffset: progress.afterOffset });
    if (!page.events.length) return;
    progress.throughOffset = page.throughOffset;
    progress.deadline = Date.now() + 20_000;
    socket.serializeAttachment(progress);
    socket.send(JSON.stringify(page));
  }

  acknowledge(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") throw new Fault("ACK", "Expected a JSON acknowledgement");
    const { afterOffset } = Ack.parse(JSON.parse(message));
    // Only stream-tagged sockets are dispatched here by Context.webSocketMessage.
    const progress = socket.deserializeAttachment() as SocketProgress;
    if (progress.deadline !== null && Date.now() >= (progress.deadline ?? 0)) {
      socket.close(1008, "Stream acknowledgement deadline exceeded");
      return;
    }
    if (progress.deadline === null || afterOffset !== progress.throughOffset)
      throw new Fault("ACK", "Acknowledge exactly the outstanding page");
    socket.serializeAttachment({ ...progress, afterOffset, deadline: null });
    this.send(socket);
  }

  publish() {
    for (const socket of this.ctx.getWebSockets("stream")) this.send(socket);
  }

  /** Close overdue readers and return the next durable ACK deadline, including after hibernation. */
  expireAcknowledgements() {
    let next: number | null = null;
    for (const socket of this.ctx.getWebSockets("stream")) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      // Only our stream-tagged sockets carry this platform-authored attachment.
      const progress = socket.deserializeAttachment() as SocketProgress;
      if (progress.deadline === null) continue;
      const deadline = progress.deadline ?? 0; // Pre-deadline attachments cannot retain a slot forever.
      if (deadline <= Date.now()) socket.close(1008, "Stream acknowledgement deadline exceeded");
      else next = Math.min(next ?? deadline, deadline);
    }
    return next;
  }
}
