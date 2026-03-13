import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { resolveLocalDockerPostgresPort } from "../../scripts/local-docker-postgres-port.ts";

const isEnabled = process.env.ENABLE_DB_CONNECTION_LEAK_TEST === "true";

const databaseUrl =
  process.env.DATABASE_URL ??
  `postgres://postgres:postgres@127.0.0.1:${resolveLocalDockerPostgresPort()}/os`;
const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:5173";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("db connection leak check", () => {
  if (!isEnabled) {
    it.skip("returns near baseline after a burst of DB work", async () => {});
    return;
  }

  it("returns near baseline after a burst of DB work", { timeout: 30_000 }, async () => {
    const observerUrl = new URL(databaseUrl);
    observerUrl.searchParams.set("application_name", "db-connection-leak-check");

    const observer = postgres(observerUrl.toString(), {
      max: 1,
      prepare: false,
    });

    const requestCount = Number(process.env.REQUEST_COUNT ?? "20");
    const holdMs = Number(process.env.HOLD_MS ?? "750");
    const baselineSamples = Number(process.env.BASELINE_SAMPLES ?? "5");
    const baselineSampleIntervalMs = Number(process.env.BASELINE_SAMPLE_INTERVAL_MS ?? "200");
    const peakPollIntervalMs = Number(process.env.PEAK_POLL_INTERVAL_MS ?? "100");
    const settleTimeoutMs = Number(process.env.SETTLE_TIMEOUT_MS ?? "20000");
    const settlePollIntervalMs = Number(process.env.SETTLE_POLL_INTERVAL_MS ?? "250");
    const allowedConnectionDrift = Number(process.env.ALLOWED_CONNECTION_DRIFT ?? "1");

    async function getConnectionCount() {
      const rows = await observer<{ connection_count: number }[]>`
          select count(*)::int as connection_count
          from pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
        `;

      return rows[0]?.connection_count ?? 0;
    }

    try {
      const probeResponse = await fetch(new URL("/api/testing/db-connection-probe", workerUrl));

      if (probeResponse.status === 404) {
        throw new Error(
          "Probe endpoint returned 404. Start the local OS worker and run with ENABLE_DB_CONNECTION_LEAK_TEST=true.",
        );
      }

      if (probeResponse.status < 200 || probeResponse.status >= 300) {
        throw new Error(
          `Probe endpoint failed health check with status ${probeResponse.status}: ${await probeResponse.text()}`,
        );
      }

      const probeOrigin = new URL(probeResponse.url).origin;

      const baselineCounts: number[] = [];
      for (let index = 0; index < baselineSamples; index += 1) {
        baselineCounts.push(await getConnectionCount());
        if (index < baselineSamples - 1) {
          await sleep(baselineSampleIntervalMs);
        }
      }

      const baselineCount = Math.max(...baselineCounts);
      const allowedSettledCount = baselineCount + allowedConnectionDrift;

      let burstComplete = false;
      const burstPromise = Promise.allSettled(
        Array.from({ length: requestCount }, () =>
          fetch(new URL(`/api/testing/db-connection-probe?holdMs=${holdMs}`, probeOrigin)),
        ),
      ).then((results) => {
        burstComplete = true;
        return results;
      });

      let peakConnectionCount = baselineCount;
      while (!burstComplete) {
        peakConnectionCount = Math.max(peakConnectionCount, await getConnectionCount());
        await sleep(peakPollIntervalMs);
      }

      const results = await burstPromise;
      peakConnectionCount = Math.max(peakConnectionCount, await getConnectionCount());

      const responses = results
        .filter(
          (result): result is PromiseFulfilledResult<Response> => result.status === "fulfilled",
        )
        .map((result) => result.value);
      const rejectedCount = results.filter((result) => result.status === "rejected").length;

      expect(rejectedCount).toBe(0);
      expect(responses).toHaveLength(requestCount);
      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(peakConnectionCount).toBeGreaterThan(baselineCount);

      const settleDeadline = Date.now() + settleTimeoutMs;
      let settledConnectionCount: number | undefined;

      while (Date.now() <= settleDeadline) {
        const connectionCount = await getConnectionCount();
        if (connectionCount <= allowedSettledCount) {
          settledConnectionCount = connectionCount;
          break;
        }
        await sleep(settlePollIntervalMs);
      }

      expect(settledConnectionCount).toBeDefined();
      expect(settledConnectionCount).toBeLessThanOrEqual(allowedSettledCount);
    } finally {
      await observer.end({ timeout: 1 });
    }
  });
});
