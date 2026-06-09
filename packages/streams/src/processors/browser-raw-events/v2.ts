import { StreamProcessor, type ProcessEventsArgs } from "../../stream-processor-v2.ts";
import type { SqlClient, SqlValue } from "../../browser/stream-browser-db.ts";
import { browserRawEventsContract } from "./contract.ts";
import { ensureBrowserRawEventsSchema } from "./implementation.ts";

export const BrowserRawEventsContract = browserRawEventsContract;
export type BrowserRawEventsContract = typeof BrowserRawEventsContract;
export type BrowserRawEventsState = Record<string, never>;

export type BrowserRawEventsProcessorDeps = {
  sql: SqlClient;
};

export class BrowserRawEventsProcessor extends StreamProcessor<
  BrowserRawEventsContract,
  BrowserRawEventsProcessorDeps
> {
  readonly contract = BrowserRawEventsContract;

  protected override processEvents(args: ProcessEventsArgs<BrowserRawEventsContract>): void {
    args.blockProcessorWhile(() =>
      ensureBrowserRawEventsSchema(this.deps.sql).then(() =>
        this.deps.sql.batch(
          args.events.map(({ event }) => ({
            sql: `INSERT INTO events (local_index, raw_jsonb) VALUES (?, jsonb(?))`,
            params: [event.offset - 1, JSON.stringify(event)] satisfies SqlValue[],
          })),
          { transaction: true },
        ),
      ),
    );
  }
}
