import { describe, expect, it } from "vitest";

const baseUrl = new URL(process.env.DURABLE_OBJECT_UTILS_E2E_BASE_URL ?? "");

describe("withLifecycleHooks fronting worker", () => {
  it("initializes a room and sends a message through the fronting worker", async () => {
    const roomName = testRoomName(`e2e-room-${crypto.randomUUID()}`, "user-e2e");

    const initialized = await postJson(`/rooms/${roomName}/initialize`, {
      ownerUserId: "user-e2e",
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toEqual({
      ownerUserId: "user-e2e",
    });

    const message = await postJson(`/rooms/${roomName}/message`, {
      text: "hello",
    });
    expect(message.status).toBe(200);
    expect(await message.json()).toEqual({
      room: decodeURIComponent(roomName),
      ownerUserId: "user-e2e",
      text: "hello",
    });
  });

  it("returns a structured NotInitializedError before initialization", async () => {
    const roomName = `e2e-room-${crypto.randomUUID()}`;
    const response = await postJson(`/rooms/${roomName}/message`, {
      text: "hello",
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "NotInitializedError",
    });
  });
});

describe("inspector mixins fronting worker", () => {
  it("serves KV and SQL inspector routes through the deployed worker", async () => {
    const inspectorName = `e2e-inspector-${crypto.randomUUID()}`;

    const kvSeeded = await postJson(`/inspectors/${inspectorName}/seed-kv`, {
      key: "room",
      value: { ownerUserId: "user-e2e" },
    });
    expect(kvSeeded.status).toBe(200);

    const kvResponse = await getWithRouteRetry(`/inspectors/${inspectorName}/__kv/json`);
    expect(kvResponse.status).toBe(200);
    expect(await kvResponse.json()).toEqual([
      {
        key: "room",
        value: { ownerUserId: "user-e2e" },
      },
    ]);

    const sqlSeeded = await postJson(`/inspectors/${inspectorName}/seed-sql`, {});
    expect(sqlSeeded.status).toBe(200);

    const sqlResponse = await postJson(`/inspectors/${inspectorName}/__outerbase/sql`, {
      statement: "SELECT id, text FROM messages ORDER BY id",
    });
    expect(sqlResponse.status).toBe(200);
    expect(await sqlResponse.json()).toMatchObject({
      data: {
        rows: [{ id: "msg_1", text: "hello" }],
      },
    });
  });
});

describe("withD1ObjectCatalog fronting worker", () => {
  it("returns JSON null when a cataloged object has no D1 record yet", async () => {
    const roomName = `e2e-listed-missing-${crypto.randomUUID()}`;
    const response = await getWithRouteRetry(`/listed-rooms/${roomName}/catalog`);

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  it("creates the D1 tables, mirrors initialized objects, and indexes structured names", async () => {
    const ownerUserId = `user-listed-e2e-${crypto.randomUUID()}`;
    const roomName = testRoomName(`e2e-listed-${crypto.randomUUID()}`, ownerUserId);

    const initialized = await postJson(`/listed-rooms/${roomName}/initialize`, {
      ownerUserId,
    });
    expect(initialized.status).toBe(200);

    const record = await waitForJson(`/listed-rooms/${roomName}/catalog`);
    expect(record).toMatchObject({
      class: "ListedRoom",
      name: decodeURIComponent(roomName),
      structuredName: {
        ownerUserId,
      },
    });

    const indexed = await waitForJson(`/listed-rooms/by-owner-user-id/${ownerUserId}`);
    expect(indexed).toMatchObject([
      {
        class: "ListedRoom",
        name: decodeURIComponent(roomName),
        structuredName: {
          ownerUserId,
        },
      },
    ]);
  });
});

describe("withMultiplexedAlarms fronting worker", () => {
  it("persists, lists, dispatches, and deletes logical alarm rows", async () => {
    const roomName = testRoomName(`e2e-alarm-${crypto.randomUUID()}`, "user-alarm-e2e");

    const initialized = await postJson(`/alarm-rooms/${roomName}/initialize`, {
      ownerUserId: "user-alarm-e2e",
    });
    expect(initialized.status).toBe(200);

    const scheduled = await postJson(`/alarm-rooms/${roomName}/schedule`, {
      key: "record",
      payload: { message: "hello from deployed e2e" },
    });
    expect(scheduled.status).toBe(200);

    const alarms = await getWithRouteRetry(`/alarm-rooms/${roomName}/alarms`);
    expect(alarms.status).toBe(200);
    expect(await alarms.json()).toMatchObject([
      {
        key: "record",
        method: "recordAlarmPayload",
        payload: { message: "hello from deployed e2e" },
      },
    ]);

    const due = await postJson(`/alarm-rooms/${roomName}/make-due`, {});
    expect(due.status).toBe(200);

    const dispatched = await postJson(`/alarm-rooms/${roomName}/run-alarm`, {});
    expect(dispatched.status).toBe(200);

    const state = await getWithRouteRetry(`/alarm-rooms/${roomName}/state`);
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({
      runs: 1,
      payload: { message: "hello from deployed e2e" },
    });

    const emptyAlarms = await getWithRouteRetry(`/alarm-rooms/${roomName}/alarms`);
    expect(emptyAlarms.status).toBe(200);
    expect(await emptyAlarms.json()).toEqual([]);
  });

  it("dispatches logical alarm rows through Cloudflare's natural alarm delivery", async () => {
    const roomName = testRoomName(`e2e-alarm-natural-${crypto.randomUUID()}`, "user-alarm-e2e");
    const message = "hello from natural Cloudflare alarm delivery";

    const initialized = await postJson(`/alarm-rooms/${roomName}/initialize`, {
      ownerUserId: "user-alarm-e2e",
    });
    expect(initialized.status).toBe(200);

    const scheduled = await postJson(`/alarm-rooms/${roomName}/schedule`, {
      key: "natural-record",
      runAt: Date.now() + 1_500,
      payload: { message },
    });
    expect(scheduled.status).toBe(200);

    await expect(waitForState(`/alarm-rooms/${roomName}/state`, { runs: 1 })).resolves.toEqual({
      runs: 1,
      payload: { message },
    });

    const emptyAlarms = await getWithRouteRetry(`/alarm-rooms/${roomName}/alarms`);
    expect(emptyAlarms.status).toBe(200);
    expect(await emptyAlarms.json()).toEqual([]);
  });
});

describe("withScheduler fronting worker", () => {
  it("runs a recurring schedule through the deployed worker", async () => {
    const roomName = testRoomName(`e2e-schedule-${crypto.randomUUID()}`, "user-scheduler-e2e");

    const initialized = await postJson(`/schedule-rooms/${roomName}/initialize`, {
      ownerUserId: "user-scheduler-e2e",
    });
    expect(initialized.status).toBe(200);

    const scheduled = await postJson(`/schedule-rooms/${roomName}/schedule`, {
      key: "poll",
      payload: { message: "hello scheduler" },
    });
    expect(scheduled.status).toBe(200);
    expect(await scheduled.json()).toMatchObject({
      key: "poll",
      recurrence: {
        type: "interval",
        everyMs: 60_000,
      },
    });

    const due = await postJson(`/schedule-rooms/${roomName}/make-due`, {
      key: "poll",
    });
    expect(due.status).toBe(200);

    const dispatched = await postJson(`/schedule-rooms/${roomName}/run-alarm`, {});
    expect(dispatched.status).toBe(200);

    const state = await getWithRouteRetry(`/schedule-rooms/${roomName}/state`);
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({
      runs: 1,
      failures: 0,
      payload: { message: "hello scheduler" },
    });

    const schedules = await getWithRouteRetry(`/schedule-rooms/${roomName}/schedules`);
    expect(schedules.status).toBe(200);
    expect(await schedules.json()).toMatchObject([
      {
        key: "poll",
        running: false,
        recurrence: {
          type: "interval",
          everyMs: 60_000,
        },
      },
    ]);
  });

  it("runs a delayed schedule through Cloudflare's natural alarm delivery", async () => {
    const roomName = testRoomName(
      `e2e-schedule-natural-${crypto.randomUUID()}`,
      "user-scheduler-e2e",
    );
    const message = "hello scheduler natural alarm";

    const initialized = await postJson(`/schedule-rooms/${roomName}/initialize`, {
      ownerUserId: "user-scheduler-e2e",
    });
    expect(initialized.status).toBe(200);

    const scheduled = await postJson(`/schedule-rooms/${roomName}/schedule`, {
      key: "natural-delayed",
      recurrence: {
        type: "delayed",
        delayMs: 1_500,
      },
      payload: { message },
    });
    expect(scheduled.status).toBe(200);

    await expect(waitForState(`/schedule-rooms/${roomName}/state`, { runs: 1 })).resolves.toEqual({
      runs: 1,
      failures: 0,
      payload: { message },
    });

    const schedules = await getWithRouteRetry(`/schedule-rooms/${roomName}/schedules`);
    expect(schedules.status).toBe(200);
    expect(await schedules.json()).toEqual([]);
  });
});

async function postJson(path: string, body: unknown): Promise<Response> {
  return await fetchWithRouteRetry(new URL(path, baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function testRoomName(testName: string, ownerUserId: string) {
  return encodeURIComponent(JSON.stringify({ ownerUserId, testName }));
}

async function getWithRouteRetry(path: string): Promise<Response> {
  return await fetchWithRouteRetry(new URL(path, baseUrl), {
    method: "GET",
  });
}

async function waitForJson(path: string) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const response = await fetch(new URL(path, baseUrl));
    if (response.status !== 200) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }

    const payload: unknown = await response.json();
    if (payload !== null) {
      return payload;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for JSON at ${path}`);
}

async function waitForState(path: string, expected: Record<string, unknown>) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const response = await fetch(new URL(path, baseUrl));
    if (response.status !== 200) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }

    const payload: unknown = await response.json();
    if (matchesExpectedState(payload, expected)) {
      return payload;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for state at ${path}`);
}

function matchesExpectedState(payload: unknown, expected: Record<string, unknown>) {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  for (const [key, value] of Object.entries(expected)) {
    if ((payload as Record<string, unknown>)[key] !== value) {
      return false;
    }
  }

  return true;
}

async function fetchWithRouteRetry(input: URL, init: RequestInit) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const response = await fetch(input, init);
    // The deployed E2E worker can briefly return routing-level 404/503 while
    // Cloudflare propagates the freshly deployed Worker. A 500 is different:
    // it means the Worker code ran and returned an application error. Some
    // tests assert those structured 500s directly, so retrying them would hide
    // whether the error response is immediate and waste the whole deadline.
    if (![404, 503].includes(response.status)) {
      return response;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return await fetch(input, init);
}
