import { Processor, type Source } from "./model.ts";
import type { EventRecord } from "./signatures.ts";
import { callTarget } from "./runtime.ts";
import { Stream } from "./stream.ts";

const DELIVERY_TIMEOUT_MS = 20_000;

type Progress = {
  name: string;
  setting_offset: number;
  cursor: number;
  attempts: number;
  retry_at: number | null;
  error: string | null;
};
/** Durable, at-least-once delivery for configured workers. The owner owns alarms. */
export class Processors {
  constructor(
    readonly ctx: DurableObjectState,
    readonly stream: Stream,
    readonly load: (source: Source) => Promise<WorkerStub>,
  ) {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS processor_progress (
      name TEXT NOT NULL, setting_offset INTEGER NOT NULL, cursor INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, error TEXT,
      PRIMARY KEY (name, setting_offset))`);
  }
  async run(): Promise<void> {
    this.removeSuperseded();
    const head = this.stream.head;
    for (const { name, offset, config } of this.configurations()) {
      const progress = this.progress(name, offset, config.afterOffset);
      if (progress.attempts >= 3 || (progress.retry_at !== null && progress.retry_at > Date.now()))
        continue;
      const page = this.stream.readEvents({ afterOffset: progress.cursor, limit: 128 });
      let worker: WorkerStub | undefined;
      for (const event of page.events) {
        if (event.offset > head) break;
        if (
          (!config.consumes.includes(event.type) && !config.consumes.includes("*")) ||
          this.isOwnConfig(name, event)
        ) {
          this.advance(name, offset, event.offset);
          continue;
        }
        try {
          worker ??= await this.load(config.source);
          await this.deliver(worker, config.exportName, event);
          this.advance(name, offset, event.offset);
        } catch (error) {
          this.fail(name, offset, event, error);
          break;
        }
      }
    }
  }
  nextWake(): number | null {
    this.removeSuperseded();
    const head = this.stream.head;
    let wake: number | null = null;
    for (const { name, offset, config } of this.configurations()) {
      const progress = this.progress(name, offset, config.afterOffset);
      if (progress.attempts >= 3) continue;
      if (progress.retry_at !== null) {
        wake = wake === null ? progress.retry_at : Math.min(wake, progress.retry_at);
        continue;
      }
      if (progress.cursor < head) return Date.now();
    }
    return wake;
  }
  state() {
    this.removeSuperseded();
    return this.ctx.storage.sql
      .exec<Progress>(
        "SELECT name, setting_offset, cursor, attempts, retry_at, error FROM processor_progress ORDER BY name, setting_offset",
      )
      .toArray();
  }
  private progress(name: string, settingOffset: number, afterOffset: number): Progress {
    const row = this.ctx.storage.sql
      .exec<Progress>(
        "SELECT name, setting_offset, cursor, attempts, retry_at, error FROM processor_progress WHERE name = ? AND setting_offset = ?",
        name,
        settingOffset,
      )
      .toArray()[0];
    if (row) return row;
    return this.ctx.storage.sql
      .exec<Progress>(
        "INSERT INTO processor_progress(name,setting_offset,cursor) VALUES (?,?,?) RETURNING name,setting_offset,cursor,attempts,retry_at,error",
        name,
        settingOffset,
        afterOffset,
      )
      .one();
  }
  private advance(name: string, settingOffset: number, cursor: number) {
    this.ctx.storage.sql.exec(
      "UPDATE processor_progress SET cursor = ?, attempts = 0, retry_at = NULL, error = NULL WHERE name = ? AND setting_offset = ?",
      cursor,
      name,
      settingOffset,
    );
  }
  private fail(name: string, settingOffset: number, event: EventRecord, error: unknown) {
    const attempts = this.progress(name, settingOffset, 0).attempts + 1;
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = `offset ${event.offset} (${event.type}): ${message}`.slice(0, 4096);
    const retryAt = attempts < 3 ? Date.now() + 1000 * 2 ** (attempts - 1) : null;
    this.ctx.storage.sql.exec(
      "UPDATE processor_progress SET attempts = ?, retry_at = ?, error = ? WHERE name = ? AND setting_offset = ?",
      attempts,
      retryAt,
      diagnostic,
      name,
      settingOffset,
    );
    console.warn("processor delivery failed", {
      attempts,
      name,
      offset: event.offset,
      retryAt,
      type: event.type,
    });
  }
  private async deliver(worker: WorkerStub, exportName: string | undefined, event: EventRecord) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        callTarget(worker.getEntrypoint(exportName), ["processEvent"], [event]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`processor timed out after ${DELIVERY_TIMEOUT_MS}ms`)),
            DELIVERY_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private removeSuperseded() {
    // Stream alone writes these validated settings; JSON null disables a processor.
    this.ctx.storage.sql.exec(`DELETE FROM processor_progress WHERE NOT EXISTS (
      SELECT 1 FROM settings WHERE key = 'processor/' || processor_progress.name
      AND offset = processor_progress.setting_offset AND value != 'null')`);
  }
  private configurations() {
    return this.stream.settings().flatMap(({ key, value, offset }) => {
      if (!key.startsWith("processor/") || value === null) return [];
      return [{ name: key.slice("processor/".length), offset, config: Processor.parse(value) }];
    });
  }
  private isOwnConfig(name: string, event: EventRecord) {
    if (event.type !== "itx.set") return false;
    // Committed itx.set records passed Setting.parse; platform appends cannot create this type.
    return (event.data as { key: string }).key === `processor/${name}`;
  }
}
