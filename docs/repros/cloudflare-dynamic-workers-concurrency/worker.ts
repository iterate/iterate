type DynamicWorkerSource = {
  compatibilityDate: string;
  globalOutbound: null;
  mainModule: string;
  modules: Record<string, string>;
};

type DynamicWorkerStub = {
  getEntrypoint(name?: string): {
    fetch(request: Request): Response | Promise<Response>;
  };
};

type DynamicWorkerLoader = {
  load(source: DynamicWorkerSource): DynamicWorkerStub;
  get(
    id: string,
    load: () => DynamicWorkerSource | Promise<DynamicWorkerSource>,
  ): DynamicWorkerStub;
};

interface Env {
  LOADER: DynamicWorkerLoader;
}

type ProbeResult =
  | {
      body: unknown;
      elapsedMs: number;
      index: number;
      ok: true;
      status: number;
    }
  | {
      elapsedMs: number;
      error: {
        message: string;
        name?: string;
        stack?: string;
      };
      index: number;
      ok: false;
    };

const COMPATIBILITY_DATE = "2026-07-07";
const DEFAULT_COUNT = 24;
const MAX_COUNT = 64;
const SAME_SOURCE_CACHE_ID = "same-source-control-v1";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const count = parseCount(url.searchParams.get("count"));

    if (url.pathname === "/" || url.pathname === "/help") {
      return json({
        endpoints: {
          "/distinct?count=24":
            "Concurrently loads count distinct Dynamic Worker sources with LOADER.load().",
          "/same-source-get?count=24":
            "Control: invokes one cached Dynamic Worker source count times concurrently with LOADER.get().",
          "/same-source-load?count=24":
            "Control: concurrently calls LOADER.load() count times with identical source bytes.",
        },
      });
    }

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname === "/distinct") {
      return json(
        await runCase("distinct-load", count, (index) =>
          env.LOADER.load(workerSource(`distinct-${index}`)),
        ),
      );
    }

    if (url.pathname === "/same-source-get") {
      const worker = env.LOADER.get(SAME_SOURCE_CACHE_ID, () => workerSource("same-source-get"));
      return json(await runCase("same-source-get", count, () => worker));
    }

    if (url.pathname === "/same-source-load") {
      const source = workerSource("same-source-load");
      return json(await runCase("same-source-load", count, () => env.LOADER.load(source)));
    }

    return json({ error: "not found" }, 404);
  },
};

async function runCase(
  name: string,
  count: number,
  workerForIndex: (index: number) => DynamicWorkerStub,
) {
  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: count }, (_, index) => invokeProbe(index, workerForIndex)),
  );
  const successCount = results.filter((result) => result.ok).length;
  const errorCount = count - successCount;

  return {
    case: name,
    count,
    elapsedMs: Date.now() - startedAt,
    errorCount,
    errorSummary: summarizeErrors(results),
    results,
    successCount,
  };
}

async function invokeProbe(
  index: number,
  workerForIndex: (index: number) => DynamicWorkerStub,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const worker = workerForIndex(index);
    const response = await worker
      .getEntrypoint()
      .fetch(new Request(`https://dynamic-worker-probe.local/?index=${index}`));
    const text = await response.text();
    return {
      body: parseBody(text),
      elapsedMs: Date.now() - startedAt,
      index,
      ok: response.ok,
      status: response.status,
    };
  } catch (error) {
    return {
      elapsedMs: Date.now() - startedAt,
      error: normalizeError(error),
      index,
      ok: false,
    };
  }
}

function workerSource(label: string): DynamicWorkerSource {
  return {
    compatibilityDate: COMPATIBILITY_DATE,
    globalOutbound: null,
    mainModule: "index.js",
    modules: {
      "index.js": `
        const loadedAt = Date.now();

        export default {
          async fetch(request) {
            const url = new URL(request.url);
            return new Response(JSON.stringify({
              ok: true,
              index: Number(url.searchParams.get("index")),
              label: ${JSON.stringify(label)},
              loadedAt,
            }), {
              headers: { "content-type": "application/json; charset=utf-8" },
            });
          },
        };
      `,
    },
  };
}

function parseCount(raw: string | null): number {
  if (raw === null) return DEFAULT_COUNT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_COUNT;
  return Math.min(parsed, MAX_COUNT);
}

function summarizeErrors(results: ProbeResult[]) {
  const summary = new Map<string, { count: number; name?: string; message: string }>();
  for (const result of results) {
    if (result.ok) continue;
    const key = `${result.error.name ?? "Error"}:${result.error.message}`;
    const existing = summary.get(key);
    if (existing === undefined) {
      summary.set(key, { count: 1, name: result.error.name, message: result.error.message });
    } else {
      existing.count += 1;
    }
  }
  return [...summary.values()];
}

function normalizeError(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status,
  });
}
