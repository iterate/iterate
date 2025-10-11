import parser from "cron-parser";
import { RRule } from "rrule";
import { z } from "zod";

type InvokeMode = "manual" | "scheduled";

type DurableObjectState = {
  storage: {
    sql: any;
    setAlarm(scheduledTime: number): void;
    deleteAlarm(): void;
  };
  blockConcurrencyWhile<T>(cb: () => Promise<T> | T): Promise<T>;
};

const RRuleInstructionInputSchema = z.object({
  kind: z.literal("rrule"),
  rrule: z.string().min(1),
});

const CronInstructionInputSchema = z.object({
  kind: z.literal("cron"),
  cron: z.string().min(1),
  timezone: z.string().min(1).optional(),
});

const OnceInstructionInputSchema = z.object({
  kind: z.literal("once"),
  at: z.union([z.number(), z.string(), z.date()]),
});

const InstructionInputSchema = z.discriminatedUnion("kind", [
  RRuleInstructionInputSchema,
  CronInstructionInputSchema,
  OnceInstructionInputSchema,
]);

type InstructionInput = z.infer<typeof InstructionInputSchema>;

const RRuleInstructionSchema = RRuleInstructionInputSchema;
const CronInstructionSchema = CronInstructionInputSchema;
const OnceInstructionSchema = z.object({
  kind: z.literal("once"),
  at: z.number().int().nonnegative(),
});

const InstructionSchema = z.discriminatedUnion("kind", [
  RRuleInstructionSchema,
  CronInstructionSchema,
  OnceInstructionSchema,
]);

type Instruction = z.infer<typeof InstructionSchema>;

const EventDirectiveAddInput = z.object({
  type: z.literal("directive_add"),
  key: z.string().min(1),
  instruction: InstructionInputSchema,
  method: z.string().min(1),
  args: z.unknown().optional(),
  meta: z.unknown().optional(),
});

const EventDirectiveChangeInput = z.object({
  type: z.literal("directive_change"),
  key: z.string().min(1),
  instruction: InstructionInputSchema,
  method: z.string().min(1),
  args: z.unknown().optional(),
  meta: z.unknown().optional(),
});

const EventDirectiveDelete = z.object({
  type: z.literal("directive_delete"),
  key: z.string().min(1),
  meta: z.unknown().optional(),
});

const EventInvoke = z.object({
  type: z.literal("invoke"),
  key: z.string().min(1),
  mode: z.enum(["manual", "scheduled"] satisfies InvokeMode[]),
  result: z
    .object({
      ok: z.boolean(),
      dur: z.number().int().nonnegative().optional(),
      retryCount: z.number().int().nonnegative().optional(),
      error: z.string().optional(),
      spanId: z.string().uuid().optional(),
      method: z.string().optional(),
      args: z.unknown().optional(),
      value: z.unknown().optional(),
    })
    .optional(),
  meta: z.unknown().optional(),
});

const LegacyEventDirectiveAdd = z.object({
  type: z.literal("rule_add"),
  key: z.string().min(1),
  rrule: z.string().min(1),
  method: z.string().min(1),
  args: z.unknown().optional(),
  meta: z.unknown().optional(),
});

const LegacyEventDirectiveChange = z.object({
  type: z.literal("rule_change"),
  key: z.string().min(1),
  rrule: z.string().min(1),
  method: z.string().min(1),
  args: z.unknown().optional(),
  meta: z.unknown().optional(),
});

const LegacyEventDirectiveDelete = z.object({
  type: z.literal("rule_delete"),
  key: z.string().min(1),
  meta: z.unknown().optional(),
});

const EventDirectiveAdd = EventDirectiveAddInput.extend({
  instruction: InstructionSchema,
});

const EventDirectiveChange = EventDirectiveChangeInput.extend({
  instruction: InstructionSchema,
});

const EventSchema = z.discriminatedUnion("type", [
  EventDirectiveAdd,
  EventDirectiveChange,
  EventDirectiveDelete,
  EventInvoke,
]);

const EventInputSchema = z.discriminatedUnion("type", [
  EventDirectiveAddInput,
  EventDirectiveChangeInput,
  EventDirectiveDelete,
  EventInvoke,
]);

const LegacyEventSchema = z.discriminatedUnion("type", [
  LegacyEventDirectiveAdd,
  LegacyEventDirectiveChange,
  LegacyEventDirectiveDelete,
  EventInvoke,
]);

type Event = z.infer<typeof EventSchema>;
type EventInput = z.infer<typeof EventInputSchema>;
type LegacyEvent = z.infer<typeof LegacyEventSchema>;

type DirectiveMutationEvent = Extract<Event, { type: "directive_add" | "directive_change" }>;
type DirectiveMutationEventInput = Extract<EventInput, { type: "directive_add" | "directive_change" }>;

type DirectiveRecord = {
  key: string;
  instruction: Instruction;
  method: string;
  args?: unknown;
  meta?: unknown;
};

type AlarmInfo = {
  retryCount?: number;
  isRetry?: boolean;
};

type InvokeContext = {
  directive: DirectiveRecord;
  mode: InvokeMode;
  retryCount: number;
};

type InvocationError = Error & {
  spanId?: string;
  duration?: number;
};

type DirectiveMethod = (ctx: InvokeContext) => unknown | Promise<unknown>;

const SAFETY_MS = 10_000;

export class Schedrruler {
  private readonly ctx: DurableObjectState;
  private readonly sql: any;
  private readonly directives = new Map<string, DirectiveRecord>();

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS events(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          type TEXT NOT NULL,
          rule_key TEXT,
          payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_rule_ts ON events(rule_key, ts);

        CREATE TABLE IF NOT EXISTS next(
          rule_key TEXT PRIMARY KEY,
          next_ts INTEGER
        );
      `);

      this.replayDirectivesFromEvents();
      this.backfillNextForActiveDirectives();
      this.rescheduleAlarm();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/events") {
        const raw = await this.safeJson(request);
        const items: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
        const accepted: Event[] = [];
        for (const item of items) {
          const parsed = EventInputSchema.safeParse(item);
          if (!parsed.success) {
            const legacy = LegacyEventSchema.safeParse(item);
            if (!legacy.success) {
              console.warn("schedrruler: drop invalid event", parsed.error.message);
              continue;
            }
            const normalizedLegacy = this.normalizeLegacyEvent(legacy.data);
            if (!normalizedLegacy) continue;
            accepted.push(normalizedLegacy);
            continue;
          }
          const normalized = this.normalizeIncomingEvent(parsed.data);
          if (!normalized) continue;
          accepted.push(normalized);
        }
        await this.addEvents(accepted);
        return json({ accepted: accepted.length });
      }

      if (request.method === "GET" && url.pathname === "/events") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
        const rows = this.sql
          .exec(
            `SELECT id, ts, type, rule_key, payload FROM events ORDER BY ts DESC, id DESC LIMIT ?`,
            Number.isNaN(limit) ? 100 : limit,
          )
          .toArray();
        return json(rows);
      }

      if (request.method === "GET" && url.pathname === "/") {
        const rows = this.sql.exec(`SELECT rule_key, next_ts FROM next`).toArray();
        const nextByKey = new Map<string, number | null>();
        for (const row of rows) {
          nextByKey.set(row.rule_key, row.next_ts ?? null);
        }
        const directives = Array.from(this.directives.values()).map((directive) => {
          const nextTs = nextByKey.get(directive.key) ?? null;
          return {
            key: directive.key,
            instruction: directive.instruction,
            method: directive.method,
            args: directive.args ?? null,
            meta: directive.meta ?? null,
            nextTs,
            next: nextTs != null ? new Date(nextTs).toISOString() : null,
          };
        });
        return json({ now: new Date().toISOString(), directives });
      }

      if (request.method === "POST" && url.pathname === "/__test/alarm") {
        await this.alarm();
        return new Response(null, { status: 204 });
      }

      return new Response("not found", { status: 404 });
    } catch (error) {
      console.error("schedrruler fetch error", error);
      return new Response(`error: ${error instanceof Error ? error.message : String(error)}`, {
        status: 500,
      });
    }
  }

  async alarm(info?: AlarmInfo): Promise<void> {
    this.ctx.storage.setAlarm(Date.now() + SAFETY_MS);

    const now = Date.now();
    const due = this.sql
      .exec(`SELECT rule_key FROM next WHERE next_ts IS NOT NULL AND next_ts <= ? ORDER BY next_ts ASC`, now)
      .toArray() as Array<{ rule_key: string }>;

    let hadError = false;

    for (const { rule_key } of due) {
      const directive = this.directives.get(rule_key);
      if (!directive) {
        this.sql.exec(`DELETE FROM next WHERE rule_key = ?`, rule_key);
        continue;
      }

      try {
        const outcome = await this.invokeDirective(directive, "scheduled", info?.retryCount ?? 0);
        const next = this.computeNextTs(directive.instruction, now, { inclusive: false });
        this.sql.exec("BEGIN IMMEDIATE");
        try {
          this.appendEvent(
            {
              type: "invoke",
              key: directive.key,
              mode: "scheduled",
              result: {
                ok: true,
                dur: outcome.duration,
                spanId: outcome.spanId,
                method: directive.method,
                args: directive.args,
                value: outcome.value,
              },
            },
            Date.now(),
          );
          if (next != null) {
            this.upsertNext(directive.key, next);
          } else {
            this.sql.exec(`DELETE FROM next WHERE rule_key = ?`, directive.key);
          }
          this.sql.exec("COMMIT");
        } catch (commitError) {
          this.sql.exec("ROLLBACK");
          throw commitError;
        }
      } catch (err) {
        hadError = true;
        this.sql.exec("BEGIN IMMEDIATE");
        try {
          this.appendEvent(
            {
              type: "invoke",
              key: directive.key,
              mode: "scheduled",
              result: {
                ok: false,
                error: String(err),
                retryCount: info?.retryCount ?? 0,
                spanId: (err as InvocationError).spanId,
                dur: (err as InvocationError).duration,
                method: directive.method,
                args: directive.args,
              },
            },
            Date.now(),
          );
          this.sql.exec("COMMIT");
        } catch {
          this.sql.exec("ROLLBACK");
        }
      }
    }

    if (hadError) {
      throw new Error("one or more scheduled invocations failed");
    }

    this.rescheduleAlarm();
  }

  private async addEvents(events: Event[]): Promise<void> {
    for (const event of events) {
      switch (event.type) {
        case "directive_add":
        case "directive_change": {
          const normalized = event as DirectiveMutationEvent;
          this.appendEvent(normalized, Date.now());
          this.directives.set(normalized.key, this.toDirectiveRecord(normalized));
          this.sql.exec(`DELETE FROM next WHERE rule_key = ?`, normalized.key);
          const ts = this.computeNextTs(normalized.instruction, Date.now(), { inclusive: true });
          if (ts != null) {
            this.upsertNext(normalized.key, ts);
          }
          break;
        }
        case "directive_delete": {
          this.appendEvent(event, Date.now());
          this.directives.delete(event.key);
          this.sql.exec(`DELETE FROM next WHERE rule_key = ?`, event.key);
          break;
        }
        case "invoke": {
          if (event.mode !== "manual") {
            console.warn("schedrruler: dropping invoke with non-manual mode from external call");
            break;
          }
          this.appendEvent(event, Date.now());

          const directive = this.directives.get(event.key);
          if (!directive) {
            console.warn("schedrruler: manual invoke skipped; directive not found", event.key);
            break;
          }

          try {
            const outcome = await this.invokeDirective(directive, "manual", 0);
            this.appendEvent(
              {
                type: "invoke",
                key: directive.key,
                mode: "manual",
                result: {
                  ok: true,
                  dur: outcome.duration,
                  spanId: outcome.spanId,
                  method: directive.method,
                  args: directive.args,
                  value: outcome.value,
                },
              },
              Date.now(),
            );
          } catch (err) {
            this.appendEvent(
              {
                type: "invoke",
                key: directive.key,
                mode: "manual",
                result: {
                  ok: false,
                  error: String(err),
                  method: directive.method,
                  args: directive.args,
                  spanId: (err as InvocationError).spanId,
                  dur: (err as InvocationError).duration,
                },
              },
              Date.now(),
            );
          }
          break;
        }
        default:
          console.warn("schedrruler: unknown event", event satisfies never);
      }
    }

    this.rescheduleAlarm();
  }

  private replayDirectivesFromEvents(): void {
    const rows = this.sql
      .exec(
        `SELECT payload FROM events
         WHERE type IN ('directive_add','directive_change','directive_delete')
         ORDER BY ts ASC, id ASC`,
      )
      .toArray();

    this.directives.clear();

    for (const row of rows) {
      const raw = JSON.parse(row.payload);
      const parsed = EventSchema.safeParse(raw);
      if (!parsed.success) {
        const legacy = LegacyEventSchema.safeParse(raw);
        if (!legacy.success) {
          console.warn("schedrruler: dropping invalid historical event", parsed.error.message);
          continue;
        }
        const upgraded = this.normalizeLegacyEvent(legacy.data);
        if (!upgraded) continue;
        if (upgraded.type === "directive_delete") {
          this.directives.delete(upgraded.key);
        } else if (upgraded.type === "invoke") {
          continue;
        } else {
          this.directives.set(upgraded.key, this.toDirectiveRecord(upgraded));
        }
        continue;
      }
      const event = parsed.data;
      if (event.type === "directive_delete") {
        this.directives.delete(event.key);
      } else if (event.type === "invoke") {
        continue;
      } else {
        this.directives.set(event.key, this.toDirectiveRecord(event));
      }
    }
  }

  private backfillNextForActiveDirectives(): void {
    const existing = new Set(
      this.sql.exec(`SELECT rule_key FROM next`).toArray().map((row: any) => row.rule_key as string),
    );
    const now = Date.now();
    for (const [key, directive] of this.directives) {
      if (existing.has(key)) continue;
      const ts = this.computeNextTs(directive.instruction, now, { inclusive: true });
      if (ts != null) {
        this.upsertNext(key, ts);
      }
    }
  }

  private upsertNext(key: string, ts: number): void {
    this.sql.exec(
      `INSERT INTO next(rule_key, next_ts) VALUES (?, ?)
       ON CONFLICT(rule_key) DO UPDATE SET next_ts=excluded.next_ts`,
      key,
      ts,
    );
  }

  private rescheduleAlarm(): void {
    const row = this.sql.exec(`SELECT MIN(next_ts) AS ts FROM next`).one() as { ts: number | null } | undefined;
    if (row?.ts != null) {
      this.ctx.storage.setAlarm(Number(row.ts));
    } else {
      this.ctx.storage.deleteAlarm();
    }
  }

  private appendEvent(event: Event, ts: number): void {
    this.sql.exec(
      `INSERT INTO events(ts, type, rule_key, payload) VALUES (?,?,?,?)`,
      ts,
      event.type,
      (event as { key?: string }).key ?? null,
      JSON.stringify(event),
    );
  }

  private computeNextTs(
    instruction: Instruction,
    afterMs: number,
    { inclusive = false }: { inclusive?: boolean } = {},
  ): number | null {
    switch (instruction.kind) {
      case "rrule": {
        try {
          const options = RRule.parseString(instruction.rrule);
          if (!options.dtstart) {
            options.dtstart = new Date();
          }
          const schedule = new RRule(options);
          const next = schedule.after(new Date(afterMs), inclusive);
          return next ? next.getTime() : null;
        } catch (error) {
          console.warn("schedrruler: invalid RRULE", instruction.rrule, error);
          return null;
        }
      }
      case "cron": {
        try {
          const currentDate = inclusive ? new Date(Math.max(afterMs - 1, 0)) : new Date(afterMs);
          const parsed = parser.parseExpression(instruction.cron, {
            currentDate,
            tz: instruction.timezone,
            iterator: false,
          });
          const nextDate = parsed.next().toDate();
          if (inclusive && nextDate.getTime() <= afterMs) {
            return afterMs;
          }
          return nextDate.getTime();
        } catch (error) {
          console.warn("schedrruler: invalid cron expression", instruction.cron, error);
          return null;
        }
      }
      case "once": {
        const ts = instruction.at;
        if (inclusive && ts <= afterMs) {
          return Math.max(ts, afterMs);
        }
        return ts > afterMs ? ts : null;
      }
      default:
        instruction satisfies never;
        return null;
    }
  }

  private normalizeIncomingEvent(event: EventInput): Event | null {
    switch (event.type) {
      case "directive_add":
      case "directive_change": {
        const instruction = this.resolveInstruction(event.instruction, event.key);
        if (!instruction) return null;
        return { ...event, instruction };
      }
      default:
        return event as Event;
    }
  }

  private normalizeLegacyEvent(event: LegacyEvent): Event | null {
    switch (event.type) {
      case "rule_add":
        return {
          type: "directive_add",
          key: event.key,
          instruction: { kind: "rrule", rrule: event.rrule },
          method: event.method,
          args: event.args,
          meta: event.meta,
        } satisfies Event;
      case "rule_change":
        return {
          type: "directive_change",
          key: event.key,
          instruction: { kind: "rrule", rrule: event.rrule },
          method: event.method,
          args: event.args,
          meta: event.meta,
        } satisfies Event;
      case "rule_delete":
        return {
          type: "directive_delete",
          key: event.key,
          meta: event.meta,
        } satisfies Event;
      case "invoke":
        return event as Event;
      default:
        event satisfies never;
        return null;
    }
  }

  private resolveInstruction(input: InstructionInput, key: string): Instruction | null {
    switch (input.kind) {
      case "rrule":
        return input;
      case "cron":
        return input;
      case "once": {
        const ts = this.toTimestamp(input.at);
        if (ts == null) {
          console.warn("schedrruler: invalid 'once' timestamp", input.at, "for", key);
          return null;
        }
        return { kind: "once", at: ts };
      }
      default:
        input satisfies never;
        return null;
    }
  }

  private toTimestamp(value: number | string | Date): number | null {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isFinite(ms) ? ms : null;
    }
    return null;
  }

  private toDirectiveRecord(event: DirectiveMutationEvent): DirectiveRecord {
    return {
      key: event.key,
      instruction: event.instruction,
      method: event.method,
      args: event.args,
      meta: event.meta,
    };
  }

  private async safeJson(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }

  private async invokeDirective(
    directive: DirectiveRecord,
    mode: InvokeMode,
    retryCount: number,
  ): Promise<{ value: unknown; duration: number; spanId: string }> {
    const spanId = crypto.randomUUID();
    const started = Date.now();
    const fn = (this as Record<string, unknown>)[directive.method];
    if (typeof fn !== "function") {
      const error = new Error(`unknown method: ${directive.method}`) as InvocationError;
      error.spanId = spanId;
      error.duration = Date.now() - started;
      throw error;
    }

    try {
      const value = await (fn as DirectiveMethod).call(this, {
        directive,
        mode,
        retryCount,
      });
      const duration = Date.now() - started;
      console.log(
        `[schedrruler] span=${spanId} directive=${directive.key} mode=${mode} ok dur=${duration}ms method=${directive.method}`,
      );
      return { value, duration, spanId };
    } catch (unknownError) {
      const duration = Date.now() - started;
      const error = (unknownError instanceof Error ? unknownError : new Error(String(unknownError))) as InvocationError;
      error.spanId = spanId;
      error.duration = duration;
      console.error(
        `[schedrruler] span=${spanId} directive=${directive.key} mode=${mode} failed after ${duration}ms method=${directive.method}`,
        error,
      );
      throw error;
    }
  }

  async log({ directive }: InvokeContext): Promise<void> {
    console.log("[schedrruler] directive triggered", directive.key, directive.args ?? "");
  }

  async error(_: InvokeContext): Promise<void> {
    throw new Error("schedrruler: simulated failure");
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
