// Opt-in calibration for the two synchronous storage surfaces exposed by a
// SQLite-backed Durable Object. Host-side timers enclose complete RPCs because
// workerd may freeze isolate clocks between I/O events.

import { expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const ENABLED = process.env.STREAM_STORAGE_BENCHMARK === "1";
const SAMPLES = Number(process.env.STREAM_STORAGE_BENCH_SAMPLES ?? "20");
const EVICTION_SAMPLES = Number(process.env.STREAM_STORAGE_BENCH_EVICTION_SAMPLES ?? "8");
const REVISION = process.env.STREAM_BENCH_REVISION ?? "unknown";

type Backend = "asyncKv" | "kv" | "sql";

type BenchmarkResult = {
  count: number;
  checksum: number;
};

type StorageBenchmarkWorker = {
  append(
    backend: Backend,
    startOffset: number,
    count: number,
    payloadBytes: number,
    keyed: boolean,
    selectedEvery: number,
  ): Promise<number>;
  evict(backend: Backend, throughOffset: number): Promise<BenchmarkResult>;
  readPoint(backend: Backend, offset: number, keyed: boolean): Promise<BenchmarkResult>;
  readRange(
    backend: Backend,
    afterOffset: number,
    throughOffset: number,
    rawLimit: number,
    selectedLimit: number,
    selectedOnly: boolean,
  ): Promise<BenchmarkResult>;
  reset(): Promise<void>;
} & Disposable;

type Summary = {
  maxMs: number;
  meanMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  samplesMs: number[];
};

type StorageSurfaceSummary = {
  asyncKv: Summary;
  asyncKvVsSqlMeanPercent: number;
  asyncKvVsSqlP50Percent: number;
  kv: Summary;
  kvVsSqlMeanPercent: number;
  kvVsSqlP50Percent: number;
  sql: Summary;
};

const workerSource = `
  import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

  const SELECTED_TYPE = "events.iterate.test/storage-benchmark/selected";
  const OTHER_TYPE = "events.iterate.test/storage-benchmark/other";
  const encoder = new TextEncoder();

  function eventPrefix(backend) {
    return "bench:" + backend + ":event:";
  }

  function eventKey(backend, offset) {
    return eventPrefix(backend) + String(offset).padStart(16, "0");
  }

  function idempotencyPrefix(backend) {
    return "bench:" + backend + ":idempotency:";
  }

  function floorKey(backend) {
    return "bench:" + backend + ":floor";
  }

  function idempotencyKey(offset) {
    return "key-" + offset;
  }

  function createEvent(offset, payloadBytes, keyed, selectedEvery) {
    const event = {
      createdAt: "2026-07-13T00:00:00.000Z",
      offset,
      payload: { blob: "x".repeat(payloadBytes), marker: "event-" + offset },
      type:
        selectedEvery > 0 && offset % selectedEvery === 0 ? SELECTED_TYPE : OTHER_TYPE,
    };
    if (keyed) event.idempotencyKey = idempotencyKey(offset);
    return event;
  }

  function placeholders(rows, width) {
    const row = "(" + Array.from({ length: width }, () => "?").join(", ") + ")";
    return Array.from({ length: rows }, () => row).join(", ");
  }

  function scheduleAsyncPuts(storage, pairs) {
    for (let start = 0; start < pairs.length; start += 128) {
      const entries = Object.create(null);
      for (const [key, value] of pairs.slice(start, start + 128)) entries[key] = value;
      void storage.put(entries);
    }
  }

  function scheduleAsyncDeletes(storage, keys) {
    for (let start = 0; start < keys.length; start += 128) {
      void storage.delete(keys.slice(start, start + 128));
    }
  }

  function checksum(events) {
    let sum = 0;
    for (const event of events) sum += event.offset + event.payload.blob.length;
    return { count: events.length, checksum: sum };
  }

  export default class StorageBenchmarkEntrypoint extends WorkerEntrypoint {}

  export class StorageBenchmarkDurableObject extends DurableObject {
    sqlReady = false;

    ensureSql() {
      if (this.sqlReady) return;
      this.ctx.storage.sql.exec(
        "create table if not exists storage_bench_events (" +
          "offset integer primary key, " +
          "type text not null, " +
          "idempotency_key text, " +
          "ephemeral integer not null default 0, " +
          "event_json blob)"
      );
      this.ctx.storage.sql.exec(
        "create unique index if not exists storage_bench_idempotency " +
          "on storage_bench_events(idempotency_key) where idempotency_key is not null"
      );
      this.ctx.storage.sql.exec(
        "create table if not exists storage_bench_meta (" +
          "singleton integer primary key check (singleton = 1), " +
          "evicted_offset_floor integer not null)"
      );
      this.ctx.storage.sql.exec(
        "insert or ignore into storage_bench_meta values (1, 0)"
      );
      this.sqlReady = true;
    }

    reset() {
      this.ensureSql();
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("delete from storage_bench_events");
        this.ctx.storage.sql.exec(
          "update storage_bench_meta set evicted_offset_floor = 0 where singleton = 1"
        );
        const keys = Array.from(this.ctx.storage.kv.list({ prefix: "bench:" }), ([key]) => key);
        for (const key of keys) this.ctx.storage.kv.delete(key);
      });
    }

    append(backend, startOffset, count, payloadBytes, keyed, selectedEvery) {
      this.ensureSql();
      const events = Array.from({ length: count }, (_, index) =>
        createEvent(startOffset + index, payloadBytes, keyed, selectedEvery)
      );
      if (backend === "asyncKv") {
        const pairs = [];
        for (const event of events) {
          pairs.push([eventKey(backend, event.offset), event]);
          if (keyed) {
            pairs.push([
              idempotencyPrefix(backend) + event.idempotencyKey,
              event.offset,
            ]);
          }
        }
        // Discarding these promises preserves automatic write coalescing. The
        // default output gate still withholds the RPC result until durability;
        // allowUnconfirmed would make this an invalid append acknowledgement.
        scheduleAsyncPuts(this.ctx.storage, pairs);
        return startOffset + count - 1;
      }
      if (backend === "kv") {
        const write = () => {
          for (const event of events) {
            this.ctx.storage.kv.put(eventKey(backend, event.offset), event);
            if (keyed) {
              this.ctx.storage.kv.put(
                idempotencyPrefix(backend) + event.idempotencyKey,
                event.offset
              );
            }
          }
        };
        if (count > 1 || keyed) this.ctx.storage.transactionSync(write);
        else write();
        return startOffset + count - 1;
      }

      const encoded = events.map((event) => encoder.encode(JSON.stringify(event)).buffer);
      const sameType = events.every((event) => event.type === events[0].type);
      const maxRows = keyed ? 20 : sameType ? 98 : 33;
      const statementCount = Math.ceil(events.length / maxRows);
      const write = () => {
        for (let start = 0; start < events.length; start += maxRows) {
          const end = Math.min(start + maxRows, events.length);
          const rows = end - start;
          if (keyed) {
            const bindings = [];
            for (let index = start; index < end; index += 1) {
              const event = events[index];
              bindings.push(event.offset, event.type, event.idempotencyKey, 0, encoded[index]);
            }
            this.ctx.storage.sql.exec(
              "insert into storage_bench_events " +
                "(offset, type, idempotency_key, ephemeral, event_json) values " +
                placeholders(rows, 5),
              ...bindings
            );
          } else if (sameType) {
            const valueRows = Array.from({ length: rows }, (_, index) =>
              "(" + index + ", ?)"
            ).join(", ");
            this.ctx.storage.sql.exec(
              "insert into storage_bench_events (offset, type, event_json) " +
                "select ? + column1, ?, column2 from (values " + valueRows + ")",
              events[start].offset,
              events[start].type,
              ...encoded.slice(start, end)
            );
          } else {
            const bindings = [];
            for (let index = start; index < end; index += 1) {
              const event = events[index];
              bindings.push(event.offset, event.type, encoded[index]);
            }
            this.ctx.storage.sql.exec(
              "insert into storage_bench_events (offset, type, event_json) values " +
                placeholders(rows, 3),
              ...bindings
            );
          }
        }
      };
      if (statementCount > 1) this.ctx.storage.transactionSync(write);
      else write();
      return startOffset + count - 1;
    }

    async readPoint(backend, offset, keyed) {
      this.ensureSql();
      let event;
      if (backend === "asyncKv") {
        const resolvedOffset = keyed
          ? await this.ctx.storage.get(
              idempotencyPrefix(backend) + idempotencyKey(offset)
            )
          : offset;
        if (resolvedOffset !== undefined) {
          event = await this.ctx.storage.get(eventKey(backend, resolvedOffset));
        }
      } else if (backend === "kv") {
        const resolvedOffset = keyed
          ? this.ctx.storage.kv.get(
              idempotencyPrefix(backend) + idempotencyKey(offset)
            )
          : offset;
        if (resolvedOffset !== undefined) {
          event = this.ctx.storage.kv.get(eventKey(backend, resolvedOffset));
        }
      } else {
        const row = keyed
          ? this.ctx.storage.sql
              .exec(
                "select cast(event_json as text) as eventJson " +
                  "from storage_bench_events where idempotency_key = ?",
                idempotencyKey(offset)
              )
              .toArray()[0]
          : this.ctx.storage.sql
              .exec(
                "select cast(event_json as text) as eventJson " +
                  "from storage_bench_events where offset = ?",
                offset
              )
              .toArray()[0];
        if (row !== undefined) event = JSON.parse(row.eventJson);
      }
      return checksum(event === undefined ? [] : [event]);
    }

    async readRange(
      backend,
      afterOffset,
      throughOffset,
      rawLimit,
      selectedLimit,
      selectedOnly
    ) {
      this.ensureSql();
      const events = [];
      if (backend === "asyncKv") {
        const rows = await this.ctx.storage.list({
          startAfter: eventKey(backend, afterOffset),
          end: eventKey(backend, throughOffset + 1),
          limit: rawLimit,
        });
        for (const event of rows.values()) {
          if (!selectedOnly || event.type === SELECTED_TYPE) events.push(event);
          if (events.length === selectedLimit) break;
        }
      } else if (backend === "kv") {
        const rows = this.ctx.storage.kv.list({
          startAfter: eventKey(backend, afterOffset),
          end: eventKey(backend, throughOffset + 1),
          limit: rawLimit,
        });
        for (const [, event] of rows) {
          if (!selectedOnly || event.type === SELECTED_TYPE) events.push(event);
          if (events.length === selectedLimit) break;
        }
      } else if (selectedOnly) {
        const rows = this.ctx.storage.sql
          .exec(
            "with raw as materialized (" +
              "select offset, type, event_json from storage_bench_events " +
              "where offset > ? and offset <= ? order by offset limit ?" +
              ") select cast(event_json as text) as eventJson from raw " +
              "where type = ? order by offset limit ?",
            afterOffset,
            throughOffset,
            rawLimit,
            SELECTED_TYPE,
            selectedLimit
          )
          .toArray();
        for (const row of rows) events.push(JSON.parse(row.eventJson));
      } else {
        const rows = this.ctx.storage.sql
          .exec(
            "select cast(event_json as text) as eventJson from storage_bench_events " +
              "where offset > ? and offset <= ? order by offset limit ?",
            afterOffset,
            throughOffset,
            selectedLimit
          )
          .toArray();
        for (const row of rows) events.push(JSON.parse(row.eventJson));
      }
      return checksum(events);
    }

    async evict(backend, throughOffset) {
      this.ensureSql();
      if (backend === "asyncKv") {
        const rows = await this.ctx.storage.list({
          start: eventPrefix(backend),
          end: eventKey(backend, throughOffset + 1),
          noCache: true,
        });
        void this.ctx.storage.put(floorKey(backend), throughOffset);
        scheduleAsyncDeletes(this.ctx.storage, [...rows.keys()]);
        return { count: 0, checksum: throughOffset };
      }
      if (backend === "kv") {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.kv.put(floorKey(backend), throughOffset);
          const keys = Array.from(
            this.ctx.storage.kv.list({
              start: eventPrefix(backend),
              end: eventKey(backend, throughOffset + 1),
            }),
            ([key]) => key
          );
          for (const key of keys) this.ctx.storage.kv.delete(key);
        });
        return { count: 0, checksum: throughOffset };
      }

      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "update storage_bench_meta set evicted_offset_floor = " +
            "max(evicted_offset_floor, ?) where singleton = 1",
          throughOffset
        );
        this.ctx.storage.sql.exec(
          "delete from storage_bench_events where offset <= ?",
          throughOffset
        );
      });
      return { count: 0, checksum: throughOffset };
    }
  }
`;

test.skipIf(!ENABLED)("SQLite storage surfaces in workerd", async () => {
  if (!Number.isInteger(SAMPLES) || SAMPLES < 1) {
    throw new Error("STREAM_STORAGE_BENCH_SAMPLES must be a positive integer.");
  }
  if (!Number.isInteger(EVICTION_SAMPLES) || EVICTION_SAMPLES < 1) {
    throw new Error("STREAM_STORAGE_BENCH_EVICTION_SAMPLES must be a positive integer.");
  }

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({
    projectId: `prj_${crypto.randomUUID()}`,
    slug: `stream-storage-bench-${crypto.randomUUID().slice(0, 8)}`,
  });
  await project.__describe();
  await project.repo.commitFiles({
    changes: [{ content: workerSource, path: "storage-benchmark.js" }],
    message: "Add storage calibration worker",
  });

  using worker = project.workers.get({
    className: "StorageBenchmarkDurableObject",
    durableWorkerKey: `storage-benchmark-${crypto.randomUUID()}`,
    path: "/",
    source: {
      files: { repoPath: "/repos/config", type: "repo" },
      options: { entryPoint: "storage-benchmark.js" },
    },
    type: "stateful",
  }) as unknown as StorageBenchmarkWorker;

  const metrics: Record<string, StorageSurfaceSummary> = {};
  // The harness calls each backend separately, so all must receive the same
  // offset range in an iteration. Keep the backend call count out of the key.
  const appendMetric = async (
    name: string,
    count: number,
    payloadBytes: number,
    keyed: boolean,
  ) => {
    await worker.reset();
    const samples = await measureSurfaces(SAMPLES, async (backend, iteration) => {
      const sequence = iteration + Math.min(3, SAMPLES);
      const startOffset = sequence * count + 1;
      return await worker.append(backend, startOffset, count, payloadBytes, keyed, 1);
    });
    metrics[name] = summarizeSurfaces(samples);
  };

  await appendMetric("append_single_1k", 1, 1_024, false);
  await appendMetric("append_batch_100_tiny", 100, 64, false);
  await appendMetric("append_batch_1000_tiny", 1_000, 64, false);
  await appendMetric("append_batch_100_1k", 100, 1_024, false);
  await appendMetric("append_batch_100_tiny_keyed", 100, 64, true);

  await worker.reset();
  await worker.append("sql", 1, 4_000, 64, false, 100);
  await worker.append("kv", 1, 4_000, 64, false, 100);
  await worker.append("asyncKv", 1, 4_000, 64, false, 100);
  metrics.read_point_offset = summarizeSurfaces(
    await measureSurfaces(SAMPLES, (backend) => worker.readPoint(backend, 3_333, false)),
  );
  metrics.read_range_100 = summarizeSurfaces(
    await measureSurfaces(SAMPLES, (backend) =>
      worker.readRange(backend, 1_000, 2_000, 100, 100, false),
    ),
  );
  metrics.read_range_1000 = summarizeSurfaces(
    await measureSurfaces(SAMPLES, (backend) =>
      worker.readRange(backend, 1_000, 2_000, 1_000, 1_000, false),
    ),
  );
  metrics.read_sparse_10_of_1000 = summarizeSurfaces(
    await measureSurfaces(SAMPLES, (backend) =>
      worker.readRange(backend, 1_000, 2_000, 1_000, 10, true),
    ),
  );

  await worker.reset();
  await worker.append("sql", 1, 2_000, 64, true, 1);
  await worker.append("kv", 1, 2_000, 64, true, 1);
  await worker.append("asyncKv", 1, 2_000, 64, true, 1);
  metrics.read_point_idempotency = summarizeSurfaces(
    await measureSurfaces(SAMPLES, (backend) => worker.readPoint(backend, 1_333, true)),
  );

  metrics.evict_1000 = summarizeSurfaces(
    await measureSurfaces(
      EVICTION_SAMPLES,
      (backend) => worker.evict(backend, 1_000),
      async () => {
        await worker.reset();
        await worker.append("sql", 1, 1_000, 64, false, 1);
        await worker.append("kv", 1, 1_000, 64, false, 1);
        await worker.append("asyncKv", 1, 1_000, 64, false, 1);
      },
    ),
  );

  console.log(
    JSON.stringify({
      benchmark: "stream-storage-kv-vs-sql",
      metrics,
      revision: REVISION,
      timestamp: new Date().toISOString(),
    }),
  );
});

function quantile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function summarize(samples: readonly number[]): Summary {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    maxMs: sorted.at(-1)!,
    meanMs: samples.reduce((total, sample) => total + sample, 0) / samples.length,
    minMs: sorted[0]!,
    p50Ms: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    samplesMs: [...samples],
  };
}

function summarizeSurfaces(samples: Record<Backend, number[]>): StorageSurfaceSummary {
  const asyncKv = summarize(samples.asyncKv);
  const kv = summarize(samples.kv);
  const sql = summarize(samples.sql);
  return {
    asyncKv,
    asyncKvVsSqlMeanPercent: (asyncKv.meanMs / sql.meanMs - 1) * 100,
    asyncKvVsSqlP50Percent: (asyncKv.p50Ms / sql.p50Ms - 1) * 100,
    kv,
    kvVsSqlMeanPercent: (kv.meanMs / sql.meanMs - 1) * 100,
    kvVsSqlP50Percent: (kv.p50Ms / sql.p50Ms - 1) * 100,
    sql,
  };
}

async function measureSurfaces<T>(
  iterations: number,
  operation: (backend: Backend, iteration: number) => Promise<T>,
  prepare?: (iteration: number) => Promise<void>,
): Promise<Record<Backend, number[]>> {
  const warmups = Math.min(3, iterations);
  const samples: Record<Backend, number[]> = { asyncKv: [], kv: [], sql: [] };
  for (let iteration = -warmups; iteration < iterations; iteration += 1) {
    await prepare?.(iteration);
    const orders: readonly (readonly Backend[])[] = [
      ["sql", "kv", "asyncKv"],
      ["kv", "asyncKv", "sql"],
      ["asyncKv", "sql", "kv"],
    ];
    const order = orders[((iteration % orders.length) + orders.length) % orders.length]!;
    let expected: T | undefined;
    for (const backend of order) {
      const startedAt = performance.now();
      const result = await operation(backend, iteration);
      const elapsedMs = performance.now() - startedAt;
      if (expected === undefined) expected = result;
      else expect(result).toEqual(expected);
      if (iteration >= 0) samples[backend].push(elapsedMs);
    }
  }
  return samples;
}
