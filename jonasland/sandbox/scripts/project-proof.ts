export type QuietRunner = (command: string, args: string[]) => string;
export type POCLogger = (message: string) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertContains(haystack: string, needle: string, context: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`Missing "${needle}" in ${context}`);
  }
}

function responseHasOk(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "ok" || normalized.includes('"ok":true') || normalized.includes('"status":"ok"')
  );
}

function curlJson(params: {
  run: QuietRunner;
  method?: "GET" | "POST";
  url: string;
  body?: unknown;
}): unknown {
  const args = ["-fsS", "-X", params.method ?? "GET"];
  if (params.body !== undefined) {
    args.push(
      "-H",
      "content-type: application/json",
      "--data",
      JSON.stringify({ json: params.body }),
    );
  }
  args.push(params.url);
  const raw = params.run("curl", args);
  const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  return "json" in parsed ? parsed.json : parsed;
}

function requireRunningState(payload: unknown, processName: string): void {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`Unexpected pidnap response while starting ${processName}`);
  }
  const state = (payload as { state?: string }).state;
  if (state !== "running") {
    throw new Error(
      `Process "${processName}" failed to reach running state (state=${String(state)})`,
    );
  }
}

export async function waitForHttpOk(params: {
  url: string;
  timeoutMs: number;
  pollMs?: number;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  const pollMs = params.pollMs ?? 1_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(params.url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for healthy endpoint: ${params.url}`);
}

async function waitForServiceHealth(params: {
  run: QuietRunner;
  url: string;
  timeoutMs: number;
  label: string;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const body = params.run("curl", ["-fsS", params.url]);
      if (responseHasOk(body)) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(800);
  }
  throw new Error(`Timed out waiting for ${params.label} health`);
}

async function waitForOrdersPlacedEvent(params: {
  run: QuietRunner;
  baseUrl: string;
  timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const eventsRaw = params.run("curl", [
        "-fsS",
        "--max-time",
        "4",
        `${params.baseUrl}/_events/api/streams/orders`,
      ]);
      if (eventsRaw.includes("orders/order-placed")) {
        return eventsRaw;
      }
    } catch {
      // retry
    }
    await sleep(800);
  }
  throw new Error("Timed out waiting for orders/order-placed event on events stream");
}

export async function runOrdersEventsProof(params: {
  baseUrl: string;
  run: QuietRunner;
  logger?: POCLogger;
  orderSku: string;
}): Promise<void> {
  const log = params.logger ?? (() => {});
  log("starting events and orders via public pidnap endpoint");

  const startOrRestart = (target: "events" | "orders") => {
    try {
      curlJson({
        run: params.run,
        method: "POST",
        url: `${params.baseUrl}/_pidnap/rpc/processes/start`,
        body: { target },
      });
    } catch {
      log(`start failed for ${target}, falling back to restart`);
      curlJson({
        run: params.run,
        method: "POST",
        url: `${params.baseUrl}/_pidnap/rpc/processes/restart`,
        body: { target },
      });
    }
  };

  startOrRestart("events");
  startOrRestart("orders");

  const eventsWait = curlJson({
    run: params.run,
    method: "POST",
    url: `${params.baseUrl}/_pidnap/rpc/processes/waitForRunning`,
    body: { target: "events", timeoutMs: 45_000, pollIntervalMs: 500 },
  });
  requireRunningState(eventsWait, "events");

  const ordersWait = curlJson({
    run: params.run,
    method: "POST",
    url: `${params.baseUrl}/_pidnap/rpc/processes/waitForRunning`,
    body: { target: "orders", timeoutMs: 45_000, pollIntervalMs: 500 },
  });
  requireRunningState(ordersWait, "orders");

  await waitForServiceHealth({
    run: params.run,
    url: `${params.baseUrl}/_events/healthz`,
    timeoutMs: 45_000,
    label: "events",
  });
  await waitForServiceHealth({
    run: params.run,
    url: `${params.baseUrl}/_orders/healthz`,
    timeoutMs: 45_000,
    label: "orders",
  });

  const orderRaw = params.run("curl", [
    "-fsS",
    "-H",
    "content-type: application/json",
    "--data",
    JSON.stringify({ sku: params.orderSku, quantity: 1 }),
    `${params.baseUrl}/_orders/api/orders`,
  ]);
  assertContains(orderRaw, '"status":"accepted"', "order placement");

  const streamRaw = await waitForOrdersPlacedEvent({
    run: params.run,
    baseUrl: params.baseUrl,
    timeoutMs: 20_000,
  });
  assertContains(streamRaw, "orders/order-placed", "orders stream");
}
