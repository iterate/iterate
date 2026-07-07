/**
 * Unit tests for the pet shop's MCP endpoint (GET|POST /mcp), driven in plain
 * Node against the real route handler over the streamable-HTTP transport that
 * createMcpHandler produces. Same fakes as worker.test.ts (in-memory storage
 * behind the state DO, cloudflare:workers shim). Hermetic — no network.
 */
import { describe, expect, test } from "vitest";
import { seedPets } from "./pets.ts";
import { randomSealKey } from "./seal.ts";
import { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET, PetshopStateDurableObject } from "./state.ts";
import { handlePetshopRequest, type PetshopDeps } from "./worker.ts";

const ORIGIN = "https://petshop.example";

/** A shop over the real state class + in-memory storage; returns its path-driven handler. */
function makeShop() {
  const blobs = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => structuredClone(blobs.get(key)),
    put: async (key: string, value: unknown) => void blobs.set(key, structuredClone(value)),
  };
  const deps: PetshopDeps = {
    state: new PetshopStateDurableObject({ storage } as unknown as DurableObjectState, {}),
    sealKey: randomSealKey(),
    pets: seedPets(),
  };
  return (path: string, init?: RequestInit) =>
    handlePetshopRequest(new Request(`${ORIGIN}${path}`, init), deps);
}

type Shop = ReturnType<typeof makeShop>;

async function accessToken(shop: Shop): Promise<string> {
  const authorize = await shop(
    `/oauth/authorize?client_id=${DEFAULT_CLIENT_ID}&redirect_uri=${encodeURIComponent(`${ORIGIN}/cb`)}&approve=1&user=Jonas`,
  );
  const code = new URL(authorize.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const token = await shop("/oauth/token", {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${DEFAULT_CLIENT_ID}:${DEFAULT_CLIENT_SECRET}`)}` },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${ORIGIN}/cb`,
    }),
  });
  return (await token.json<{ access_token: string }>()).access_token;
}

/** The JSON-RPC result of one /mcp exchange, whether the transport answered in JSON or SSE. */
async function mcp(
  shop: Shop,
  token: string,
  message: { id: number; method: string; params?: unknown },
): Promise<{ result?: Record<string, any>; error?: { message: string } }> {
  const response = await shop("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
  });
  expect(response.ok).toBe(true);
  const raw = await response.text();
  // The transport answers modern single-shot exchanges as JSON, and upgrades
  // to an SSE stream (`data:` frames) when it emits anything before the result.
  if (raw.trimStart().startsWith("{")) return JSON.parse(raw);
  const dataLine = raw
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .pop();
  return JSON.parse((dataLine ?? "data:{}").slice(5));
}

const INITIALIZE = {
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "petshop-test", version: "0.0.0" },
  },
};

describe("mcp endpoint", () => {
  test("initialize → tools/list → tools/call with a valid token", async () => {
    const shop = makeShop();
    const token = await accessToken(shop);

    const init = await mcp(shop, token, INITIALIZE);
    expect(init.result?.serverInfo?.name).toBe("dummy-petshop");

    const list = await mcp(shop, token, { id: 1, method: "tools/list", params: {} });
    const tools = (list.result?.tools ?? []) as { name: string }[];
    expect(tools.map((tool) => tool.name).sort()).toEqual(["create_pet", "get_pet", "list_pets"]);

    const listPets = await mcp(shop, token, {
      id: 2,
      method: "tools/call",
      params: { name: "list_pets", arguments: {} },
    });
    const listText = listPets.result?.content?.[0]?.text as string;
    expect(JSON.parse(listText)).toMatchObject({
      owner: "Jonas",
      pets: [{ name: "Biscuit" }, { name: "Goldie" }],
    });

    const getPet = await mcp(shop, token, {
      id: 3,
      method: "tools/call",
      params: { name: "get_pet", arguments: { id: "pet-1" } },
    });
    expect(JSON.parse(getPet.result?.content?.[0]?.text as string)).toMatchObject({
      name: "Biscuit",
      species: "beagle",
    });
  });

  test("401 without a bearer token", async () => {
    const shop = makeShop();
    const response = await shop("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(401);
  });
});
