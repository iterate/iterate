/**
 * Unit tests for the pet shop's MCP endpoint (GET|POST /mcp), driven in plain
 * Node against the real route handler over the streamable-HTTP transport that
 * createMcpHandler produces, over the test/shop.ts in-memory storage fake and
 * the cloudflare:workers shim. Hermetic — no network.
 */
import { describe, expect, test } from "vitest";
import { accessToken, makeShop, type Shop } from "./test/shop.ts";

/** The JSON-RPC result of one /mcp exchange, whether the transport answered in JSON or SSE. */
async function mcp(
  shop: Shop,
  token: string,
  message: { id: number; method: string; params?: unknown },
): Promise<{ result?: Record<string, any>; error?: { message: string } }> {
  const response = await shop.call("/mcp", {
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
  return JSON.parse((dataLine || "data:{}").slice(5));
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
    const response = await shop.call("/mcp", {
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
