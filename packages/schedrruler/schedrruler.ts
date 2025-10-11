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

const EventRuleAdd = z.object({
  type: z.literal("rule_add"),
  key: z.string().min(1),
  rrule: z.string().min(1),
  method: z.string().min(1),
  args: z.unknown().optional(),
  meta: z.unknown().optional(),
});

const EventRuleChange = z.object({
  type: z.literal("rule_change"),
  key: z.string().min(1),
  rrule: z.string().min(1),
  method: z.string().min(1),
  args: z.unknown().optional(),
  meta: z.unknown().optional(),
});

const EventRuleDelete = z.object({
  type: z.literal("rule_delete"),
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

const EventSchema = z.discriminatedUnion("type", [
  EventRuleAdd,
  EventRuleChange,
  EventRuleDelete,
  EventInvoke,
]);

type Event = z.infer<typeof EventSchema>;

type RuleRecord = {
  key: string;
  rrule: string;
  method: string;
  args?: unknown;
  meta?: unknown;
};

type RuleMutationEvent = Extract<Event, { type: "rule_add" | "rule_change" }>;

type AlarmInfo = {
  retryCount?: number;
  isRetry?: boolean;
};

type InvokeContext = {
  rule: RuleRecord;
  mode: InvokeMode;
  retryCount: number;
};

type InvocationError = Error & {
  spanId?: string;
  duration?: number;
};

type RuleMethod = (ctx: InvokeContext) => unknown | Promise<unknown>;

const SAFETY_MS = 10_000;

export class Schedrruler {
  private readonly ctx: DurableObjectState;
  private readonly sql: any;
  private readonly rules = new Map<string, RuleRecord>();

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

      this.replayRulesFromEvents();
      this.backfillNextForActiveRules();
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
          const parsed = EventSchema.safeParse(item);
          if (!parsed.success) {
            console.warn("schedrruler: drop invalid event", parsed.error.message);
            continue;
          }
          accepted.push(parsed.data);
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
        const rules = Array.from(this.rules.values()).map((rule) => {
          const nextTs = nextByKey.get(rule.key) ?? null;
          return {
            key: rule.key,
            rrule: rule.rrule,
            method: rule.method,
            args: rule.args ?? null,
            meta: rule.meta ?? null,
            nextTs,
            next: nextTs != null ? new Date(nextTs).toISOString() : null,
          };
        });
        return json({ now: new Date().toISOString(), rules });
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
      const rule = this.rules.get(rule_key);
      if (!rule) {
        this.sql.exec(`DELETE FROM next WHERE rule_key = ?`, rule_key);
        continue;
      }

      try {
        const outcome = await this.invokeRule(rule, "scheduled", info?.retryCount ?? 0);
        const next = this.computeNextTs(rule.rrule, now);
        this.sql.exec("BEGIN IMMEDIATE");
        try {
          this.appendEvent(
            {
              type: "invoke",
              key: rule.key,
              mode: "scheduled",
              result: {
                ok: true,
                dur: outcome.duration,
                spanId: outcome.spanId,
                method: rule.method,
                args: rule.args,
                value: outcome.value,
              },
            },
            Date.now(),
          );
          if (next != null) {
            this.upsertNext(rule.key, next);
          } else {
            this.sql.exec(`DELETE FROM next WHERE rule_key = ?`, rule.key);
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
              key: rule.key,
              mode: "scheduled",
              result: {
                ok: false,
                error: String(err),
                retryCount: info?.retryCount ?? 0,
                spanId: (err as InvocationError).spanId,
                dur: (err as InvocationError).duration,
                method: rule.method,
                args: rule.args,
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
        case "rule_add":
        case "rule_change": {
          const ruleEvent = event as RuleMutationEvent;
          this.appendEvent(ruleEvent, Date.now());
          this.rules.set(ruleEvent.key, {
            key: ruleEvent.key,
            rrule: ruleEvent.rrule,
            method: ruleEvent.method,
            args: ruleEvent.args,
            meta: ruleEvent.meta,
          });
          this.sql.exec(`DELETE FROM next WHERE rule_key = ?`, ruleEvent.key);
          const ts = this.computeNextTs(ruleEvent.rrule, Date.now());
          if (ts != null) {
            this.upsertNext(ruleEvent.key, ts);
          }
          break;
        }
        case "rule_delete": {
          this.appendEvent(event, Date.now());
          this.rules.delete(event.key);
          this.sql.exec(`DELETE FROM next WHERE rule_key = ?`, event.key);
          break;
        }
        case "invoke": {
          if (event.mode !== "manual") {
            console.warn("schedrruler: dropping invoke with non-manual mode from external call");
            break;
          }
          this.appendEvent(event, Date.now());

          const rule = this.rules.get(event.key);
          if (!rule) {
            console.warn("schedrruler: manual invoke skipped; rule not found", event.key);
            break;
          }

          try {
            const outcome = await this.invokeRule(rule, "manual", 0);
            this.appendEvent(
              {
                type: "invoke",
                key: rule.key,
                mode: "manual",
                result: {
                  ok: true,
                  dur: outcome.duration,
                  spanId: outcome.spanId,
                  method: rule.method,
                  args: rule.args,
                  value: outcome.value,
                },
              },
              Date.now(),
            );
          } catch (err) {
            this.appendEvent(
              {
                type: "invoke",
                key: rule.key,
                mode: "manual",
                result: {
                  ok: false,
                  error: String(err),
                  method: rule.method,
                  args: rule.args,
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

  private replayRulesFromEvents(): void {
    const rows = this.sql
      .exec(
        `SELECT payload FROM events
         WHERE type IN ('rule_add','rule_change','rule_delete')
         ORDER BY ts ASC, id ASC`,
      )
      .toArray();

    this.rules.clear();

    for (const row of rows) {
      const parsed = EventSchema.safeParse(JSON.parse(row.payload));
      if (!parsed.success) {
        console.warn("schedrruler: dropping invalid historical event", parsed.error.message);
        continue;
      }
      const event = parsed.data;
      if (event.type === "rule_delete") {
        this.rules.delete(event.key);
      } else {
        const ruleEvent = event as RuleMutationEvent;
        this.rules.set(ruleEvent.key, {
          key: ruleEvent.key,
          rrule: ruleEvent.rrule,
          method: ruleEvent.method,
          args: ruleEvent.args,
          meta: ruleEvent.meta,
        });
      }
    }
  }

  private backfillNextForActiveRules(): void {
    const existing = new Set(
      this.sql.exec(`SELECT rule_key FROM next`).toArray().map((row: any) => row.rule_key as string),
    );
    const now = Date.now();
    for (const [key, rule] of this.rules) {
      if (existing.has(key)) continue;
      const ts = this.computeNextTs(rule.rrule, now);
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

  private computeNextTs(rrule: string, afterMs: number): number | null {
    try {
      const options = RRule.parseString(rrule);
      if (!options.dtstart) {
        options.dtstart = new Date();
      }
      const schedule = new RRule(options);
      const next = schedule.after(new Date(afterMs), false);
      return next ? next.getTime() : null;
    } catch (error) {
      console.warn("schedrruler: invalid RRULE", rrule, error);
      return null;
    }
  }

  private async safeJson(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }

  private async invokeRule(
    rule: RuleRecord,
    mode: InvokeMode,
    retryCount: number,
  ): Promise<{ value: unknown; duration: number; spanId: string }> {
    const spanId = crypto.randomUUID();
    const started = Date.now();
    const fn = (this as Record<string, unknown>)[rule.method];
    if (typeof fn !== "function") {
      const error = new Error(`unknown method: ${rule.method}`) as InvocationError;
      error.spanId = spanId;
      error.duration = Date.now() - started;
      throw error;
    }

    try {
      const value = await (fn as RuleMethod).call(this, {
        rule,
        mode,
        retryCount,
      });
      const duration = Date.now() - started;
      console.log(
        `[schedrruler] span=${spanId} rule=${rule.key} mode=${mode} ok dur=${duration}ms method=${rule.method}`,
      );
      return { value, duration, spanId };
    } catch (unknownError) {
      const duration = Date.now() - started;
      const error = (unknownError instanceof Error ? unknownError : new Error(String(unknownError))) as InvocationError;
      error.spanId = spanId;
      error.duration = duration;
      console.error(
        `[schedrruler] span=${spanId} rule=${rule.key} mode=${mode} failed after ${duration}ms method=${rule.method}`,
        error,
      );
      throw error;
    }
  }

  async log({ rule }: InvokeContext): Promise<void> {
    console.log("[schedrruler] rule triggered", rule.key, rule.args ?? "");
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
