// library-connectors-mcp-openapi-capnweb.e2e — THE LIBRARY, end to end against a REAL third party:
// `itx.connectToMcp`, `itx.connectToOpenApi`, `itx.connectToCapnweb` reach the deployed pet shop
// (apps/dummy-petshop — https://dummy-petshop.iterate.com, or PETSHOP_BASE_URL) through the client
// context's own egress: its MCP server at /mcp, its OpenAPI document at /openapi.json (served REST-shaped
// under /api/v2), and its capnweb door at /capnweb (batch and WebSocket). Every door takes the shop's
// ordinary bearer token in the Authorization header, minted here the cheapest way the shop offers
// (legacy login, any email + the fixture password) and passed as the connector's `headers` option —
// exactly what a user would write. THIS FILE DEPENDS ON THE DEPLOYED PET SHOP. Locally egress is the
// DummyControlPlane (Node's fetch, which reaches the internet but cannot upgrade to a WebSocket, so the
// WebSocket transport is proved against the deployed worker only); deployed it is the control plane. The
// last two tests dial THIS worker's own /api through the library: a context calling another project.
import { afterAll, beforeAll, expect, test } from "vitest";
import { disposeSessions, freshCtx, openItx, workerUrl } from "./support/client.ts";

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(process.env.WORKER_BASE_URL ?? "");
const PETSHOP = (process.env.PETSHOP_BASE_URL ?? "https://dummy-petshop.iterate.com").replace(
  /\/+$/,
  "",
);
const PETSHOP_WS = PETSHOP.replace(/^http/, "ws");

/** The shop's pets as its API objects spell them. */
type Pet = { id: string; name: string; species: string };

/** A live bearer for `owner` (a legacy-login token: 120 s TTL, minted fresh for every test that needs one). */
async function bearerFor(owner: string): Promise<{ authorization: string }> {
  const response = await fetch(`${PETSHOP}/api/legacy-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: owner, password: "correct-horse" }),
  });
  if (!response.ok)
    throw new Error(`pet shop legacy-login answered ${response.status} at ${PETSHOP}`);
  const { accessToken } = (await response.json()) as { accessToken: string };
  return { authorization: `Bearer ${accessToken}` };
}

/** The connector options, as the ONE spelling a rule target or a call can carry. */
const withHeaders = (headers: Record<string, string>) => JSON.stringify({ headers });

beforeAll(async () => {
  const index = await fetch(`${PETSHOP}/`).catch(() => null);
  if (!index?.ok)
    throw new Error(`the deployed pet shop is not answering at ${PETSHOP} (set PETSHOP_BASE_URL)`);
});
afterAll(() => disposeSessions());

test("connectToMcp: the pet shop's MCP server — initialize + tools/list at connect, a tool as a method, callTool, an isError tool call throws, held across calls", async () => {
  const headers = await bearerFor("mcp@example.com");
  const itx = openItx(freshCtx("lib-mcp"));
  const tools = await itx.invoke(
    `itx.connectToMcp(${JSON.stringify(`${PETSHOP}/mcp`)}, ${withHeaders(headers)}).listTools()`,
  );
  expect(tools.map((t: any) => t.name).sort()).toEqual(["create_pet", "get_pet", "list_pets"]);
  // the shop answers its tools as JSON text; the connector parses it
  expect(
    await itx.invoke(
      `itx.connectToMcp(${JSON.stringify(`${PETSHOP}/mcp`)}, ${withHeaders(headers)}).callTool('get_pet', { id: 'pet-1' })`,
    ),
  ).toMatchObject({ id: "pet-1", name: "Biscuit", species: "beagle" });
  // held across calls: the connection is an RpcTarget the client keeps, its tools are its methods
  const conn = await itx.connectToMcp(`${PETSHOP}/mcp`, { headers });
  expect((await conn.serverInfo()).serverInfo).toMatchObject({ name: "dummy-petshop" });
  const listed = await conn.list_pets({});
  expect(listed.owner).toBe("mcp@example.com");
  expect(listed.pets.map((p: Pet) => p.name)).toContain("Biscuit");
  expect(await conn.create_pet({ name: "Rex", species: "terrier" })).toMatchObject({
    name: "Rex",
    species: "terrier",
  });
  await expect(conn.callTool("get_pet", { id: "pet-nope" })).rejects.toThrow(
    /No pet with id pet-nope/,
  );
  await conn.close();
});

test("connectToMcp: without the bearer the shop's 401 reaches the caller", async () => {
  const itx = openItx(freshCtx("lib-mcp-401"));
  await expect(
    itx.invoke(`itx.connectToMcp(${JSON.stringify(`${PETSHOP}/mcp`)}).listTools()`),
  ).rejects.toThrow(/401/);
});

test("rules composition: provide('itx.tools', \"itx.connectToMcp('<petshop>/mcp', { headers })\") then itx.tools.listTools() and itx.tools.get_pet(...) run through the table", async () => {
  const headers = await bearerFor("mcp-rule@example.com");
  const itx = openItx(freshCtx("lib-mcp-rule"));
  await itx.provide(
    "itx.tools",
    `itx.connectToMcp(${JSON.stringify(`${PETSHOP}/mcp`)}, ${withHeaders(headers)})`,
  );
  expect((await itx.tools.listTools()).map((t: any) => t.name).sort()).toEqual([
    "create_pet",
    "get_pet",
    "list_pets",
  ]);
  expect(await itx.tools.get_pet({ id: "pet-2" })).toMatchObject({ id: "pet-2", name: "Goldie" });
  const chain = await itx.rewriteRules.resolve("itx.tools.get_pet");
  expect(chain.at(-1)).toMatch(/^itx\.builtins\.connectToMcp\(.*\)\.get_pet$/);
});

test("connectToOpenApi: the shop's OpenAPI 3.1 document (bearer-protected, fetched over egress); operationIds become methods; path and body parameters ride to /api/v2", async () => {
  const headers = await bearerFor("openapi@example.com");
  const itx = openItx(freshCtx("lib-openapi"));
  const pets = await itx.connectToOpenApi(`${PETSHOP}/openapi.json`, { headers });
  expect((await pets.operations()).map((o: any) => o.operationId).sort()).toEqual([
    "createPet",
    "getPet",
    "listPets",
  ]);
  const listed = await pets.listPets();
  expect(listed.owner).toBe("openapi@example.com");
  expect(listed.pets.map((p: Pet) => p.name)).toContain("Goldie");
  expect(await pets.getPet({ id: "pet-1" })).toMatchObject({
    id: "pet-1",
    name: "Biscuit",
    species: "beagle",
  });
  expect(await pets.createPet({ name: "Ace", species: "parrot" })).toMatchObject({
    name: "Ace",
    species: "parrot",
  });
  await expect(pets.getPet({ id: "pet-nope" })).rejects.toThrow(/getPet\) returned 404/);
  // and as one dotted expression through the table
  await itx.provide(
    "itx.pets",
    `itx.connectToOpenApi(${JSON.stringify(`${PETSHOP}/openapi.json`)}, ${withHeaders(headers)})`,
  );
  expect(await itx.pets.getPet({ id: "pet-2" })).toMatchObject({ id: "pet-2", name: "Goldie" });
});

test("connectToOpenApi: without the bearer the document itself is a 401", async () => {
  const itx = openItx(freshCtx("lib-openapi-401"));
  await expect(
    itx.invoke(`itx.connectToOpenApi(${JSON.stringify(`${PETSHOP}/openapi.json`)}).operations()`),
  ).rejects.toThrow(/returned 401/);
});

test.skipIf(LOCAL)(
  "connectToCapnweb: the shop's /capnweb over a WebSocket session THROUGH EGRESS — the bearer rides the upgrade header; a chain pipelines; held; disposed on close",
  async () => {
    const headers = await bearerFor("capnweb-ws@example.com");
    const itx = openItx(freshCtx("lib-capnweb"));
    expect(
      await itx.invoke(
        `itx.connectToCapnweb(${JSON.stringify(`${PETSHOP_WS}/capnweb`)}, ${withHeaders(headers)}).getPet('pet-1')`,
      ),
    ).toMatchObject({ id: "pet-1", name: "Biscuit" });
    const conn = await itx.connectToCapnweb(`${PETSHOP_WS}/capnweb`, { headers });
    expect((await conn.listPets()).owner).toBe("capnweb-ws@example.com");
    const created = await conn.createPet({ name: "Ace", species: "parrot" });
    expect(await conn.getPet(created.id)).toMatchObject({ name: "Ace", species: "parrot" });
    await expect(conn.getPet("pet-nope")).rejects.toThrow(/No pet with id pet-nope/);
    conn[Symbol.dispose]();
  },
);

test.skipIf(LOCAL)(
  "connectToCapnweb, WebSocket: without the bearer the upgrade is refused (401, no socket)",
  async () => {
    const itx = openItx(freshCtx("lib-capnweb-401"));
    await expect(
      itx.invoke(`itx.connectToCapnweb(${JSON.stringify(`${PETSHOP_WS}/capnweb`)}).listPets()`),
    ).rejects.toThrow(/401/);
  },
);

test("connectToCapnweb, batch transport: one POST per chain to the shop's /capnweb, over egress, the bearer on the POST", async () => {
  const headers = await bearerFor("capnweb-batch@example.com");
  const itx = openItx(freshCtx("lib-capnweb-batch"));
  expect(
    await itx.invoke(
      `itx.connectToCapnweb(${JSON.stringify(`${PETSHOP}/capnweb`)}, ${JSON.stringify({ transport: "batch", headers })}).getPet('pet-2')`,
    ),
  ).toMatchObject({ id: "pet-2", name: "Goldie" });
  const conn = await itx.connectToCapnweb(`${PETSHOP}/capnweb`, { transport: "batch", headers });
  expect((await conn.listPets()).owner).toBe("capnweb-batch@example.com");
  expect(await conn.createPet({ name: "Rex", species: "terrier" })).toMatchObject({ name: "Rex" });
  // without the bearer: the shop's 401 is the batch's failure
  await expect(
    itx.invoke(
      `itx.connectToCapnweb(${JSON.stringify(`${PETSHOP}/capnweb`)}, { transport: 'batch' }).listPets()`,
    ),
  ).rejects.toThrow(/401/);
});

test("self-dial, batch: a context calls ANOTHER project through this worker's own /api in one POST, over the library", async () => {
  const other = freshCtx("lib-other");
  const itx = openItx(freshCtx("lib-self-dial"));
  const whoami = await itx.invoke(
    `itx.connectToCapnweb(${JSON.stringify(workerUrl("/api"))}, { transport: 'batch' }).authenticate().projects.get(${JSON.stringify(other)}).whoami()`,
  );
  expect(whoami).toEqual({ projectId: other, path: "/" });
});

test.skipIf(LOCAL)(
  "self-dial, WebSocket: the same call over a WebSocket session through the deployed egress",
  async () => {
    const other = freshCtx("lib-other-ws");
    const itx = openItx(freshCtx("lib-self-dial-ws"));
    const api = workerUrl("/api").replace(/^http/, "ws");
    const whoami = await itx.invoke(
      `itx.connectToCapnweb(${JSON.stringify(api)}).authenticate().projects.get(${JSON.stringify(other)}).whoami()`,
    );
    expect(whoami).toEqual({ projectId: other, path: "/" });
  },
);
