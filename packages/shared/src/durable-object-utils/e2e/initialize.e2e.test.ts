import { describe, expect, it } from "vitest";

const baseUrl = new URL(process.env.DURABLE_OBJECT_UTILS_E2E_BASE_URL ?? "");

describe("withInitialize fronting worker", () => {
  it("initializes a room and sends a message through the fronting worker", async () => {
    const roomName = `e2e-room-${crypto.randomUUID()}`;

    const initialized = await postJson(`/rooms/${roomName}/initialize`, {
      ownerUserId: "user-e2e",
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toEqual({
      name: roomName,
      ownerUserId: "user-e2e",
    });

    const message = await postJson(`/rooms/${roomName}/message`, {
      text: "hello",
    });
    expect(message.status).toBe(200);
    expect(await message.json()).toEqual({
      room: roomName,
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

    const kvResponse = await fetch(new URL(`/inspectors/${inspectorName}/__kv/json`, baseUrl));
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

describe("withExternalListing fronting worker", () => {
  it("creates the D1 table and mirrors initialized objects", async () => {
    const roomName = `e2e-listed-${crypto.randomUUID()}`;

    const initialized = await postJson(`/listed-rooms/${roomName}/initialize`, {
      ownerUserId: "user-listed-e2e",
    });
    expect(initialized.status).toBe(200);

    const listing = await waitForJson(`/listed-rooms/${roomName}/listing`);
    expect(listing).toMatchObject({
      class: "ListedRoom",
      name: roomName,
      initParams: {
        name: roomName,
        ownerUserId: "user-listed-e2e",
      },
    });
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

async function fetchWithRouteRetry(input: URL, init: RequestInit) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const response = await fetch(input, init);
    if (response.status !== 404) {
      return response;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return await fetch(input, init);
}
