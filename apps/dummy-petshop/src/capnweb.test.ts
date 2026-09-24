/**
 * Unit tests for the pet shop's capnweb door (`POST /capnweb`, the HTTP-batch
 * half — the WebSocket half needs workerd's WebSocketPair, so the live e2e
 * drives it), driven in plain Node against the real route handler with a REAL
 * capnweb client whose global fetch is routed into the shop, over the
 * test/shop.ts in-memory storage fake and the cloudflare:workers shim.
 * Hermetic — no network.
 */
/* oxlint-disable iterate/no-capnweb-http-batch -- these tests drive the pet shop SERVER's HTTP-batch /capnweb door on purpose (the WebSocket half is covered separately); the rule targets stateless-worker client code, not a batch handler under test */
import { newHttpBatchRpcSession } from "capnweb";
import { expect, onTestFinished, test, vi } from "vitest";
import { accessToken, makeShop, ORIGIN, type Shop } from "./test/shop.ts";

test("HTTP batch: listPets / getPet / createPet for a valid bearer token, and the writes persist", async () => {
  const shop = makeShop();
  const token = await accessToken(shop);
  const { session } = capnwebClient(shop, token);

  const listed = await session().listPets();
  expect(listed).toMatchObject({ owner: "Jonas" });
  expect(listed.pets.map((pet) => pet.name)).toEqual(["Biscuit", "Goldie"]);

  expect(await session().getPet("pet-2")).toMatchObject({ name: "Goldie", species: "goldfish" });

  const created = await session().createPet({ name: "Rex", species: "terrier" });
  expect(created).toMatchObject({ id: "pet-3", name: "Rex", species: "terrier" });
  // the same catalogue the other surfaces read
  const viaRest = await shop.call("/api/pets", { headers: bearer(token) });
  expect((await viaRest.json<{ pets: unknown[] }>()).pets).toHaveLength(3);
});

test("a whole chain rides ONE batch POST (pipelining)", async () => {
  const shop = makeShop();
  const token = await accessToken(shop);
  const { session, posts } = capnwebClient(shop, token);

  const api = session();
  const [created, listed, fetched] = await Promise.all([
    api.createPet({ name: "Ace", species: "parrot" }),
    api.listPets(),
    api.getPet("pet-1"),
  ]);
  expect(created).toMatchObject({ id: "pet-3", name: "Ace" });
  expect(listed.pets).toHaveLength(3);
  expect(fetched).toMatchObject({ name: "Biscuit" });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ method: "POST" });
  expect(new URL(posts[0].url)).toMatchObject({ pathname: "/capnweb" });
});

test("an unknown pet id rejects with the shop's message", async () => {
  const shop = makeShop();
  const token = await accessToken(shop);
  const { session } = capnwebClient(shop, token);
  await expect(session().getPet("pet-99")).rejects.toThrow(/No pet with id pet-99/);
});

test("401 without a bearer token — the door itself, and as the client sees it", async () => {
  const shop = makeShop();
  const direct = await shop.call("/capnweb", { method: "POST", body: "" });
  expect(direct).toMatchObject({ status: 401 });
  expect(await direct.json()).toMatchObject({ error: "invalid_token" });

  const { session } = capnwebClient(shop);
  await expect(session().listPets()).rejects.toThrow(/401/);
});

test("GET /capnweb without an Upgrade is capnweb's 400, never a socket", async () => {
  const shop = makeShop();
  const token = await accessToken(shop);
  const response = await shop.call("/capnweb", { headers: bearer(token) });
  expect(response).toMatchObject({ status: 400 });
  expect(await response.text()).toMatch(/POST or WebSocket/);
});

/** The pet shop's capnweb API as a client sees it (the methods PetshopCapnwebApi exposes). */
type PetshopApi = {
  listPets(): Promise<{ owner: string; pets: { id: string; name: string; species: string }[] }>;
  getPet(id: string): Promise<{ id: string; name: string; species: string }>;
  createPet(input: {
    name: string;
    species: string;
  }): Promise<{ id: string; name: string; species: string }>;
};
/**
 * A capnweb HTTP-batch client over `/capnweb`. capnweb's batch client POSTs
 * through the GLOBAL fetch, so it is routed into the shop here and every POST
 * is recorded — the pipelining assertion counts them. One session is ONE
 * batch (capnweb's contract), so a test opens a fresh one per chain.
 */
function capnwebClient(shop: Shop, token?: string) {
  const posts: Request[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    posts.push(request);
    return shop.fetch(request);
  });
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return {
    posts,
    session: () =>
      newHttpBatchRpcSession(
        new Request(`${ORIGIN}/capnweb`, token ? { headers: bearer(token) } : undefined),
      ) as unknown as PetshopApi,
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
