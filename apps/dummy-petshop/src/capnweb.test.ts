/**
 * Unit tests for the pet shop's capnweb door (`POST /capnweb`, the HTTP-batch
 * half — the WebSocket half needs workerd's WebSocketPair, so the live e2e
 * drives it), driven in plain Node against the real route handler with a REAL
 * capnweb client whose global fetch is routed into the shop. Same fakes as
 * worker.test.ts: an in-memory storage map behind the state DO and the
 * cloudflare:workers shim. Hermetic — no network.
 */
import { newHttpBatchRpcSession } from "capnweb";
import { afterEach, describe, expect, test, vi } from "vitest";
import { seedPets } from "./pets.ts";
import { randomSealKey } from "./seal.ts";
import { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET, PetshopStateDurableObject } from "./state.ts";
import { handlePetshopRequest, type PetshopDeps } from "./worker.ts";

const ORIGIN = "https://petshop.example";

/**
 * A shop instance over the real state class + in-memory storage. `call` drives
 * it by path+init; `fetch` drives it by a whole Request (what the capnweb
 * client's POSTs become) — both hit the same deps, so a client's writes are
 * visible to later `call`s.
 */
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
  return {
    call: (path: string, init?: RequestInit) =>
      handlePetshopRequest(new Request(`${ORIGIN}${path}`, init), deps),
    fetch: (request: Request) => handlePetshopRequest(request, deps),
  };
}

type Shop = ReturnType<typeof makeShop>;

/** Run the full consent → code → token dance and return a live access token. */
async function accessToken(shop: Shop): Promise<string> {
  const authorize = await shop.call(
    `/oauth/authorize?client_id=${DEFAULT_CLIENT_ID}&redirect_uri=${encodeURIComponent(`${ORIGIN}/cb`)}&approve=1&user=Jonas`,
  );
  const code = new URL(authorize.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const token = await shop.call("/oauth/token", {
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
  const session = () =>
    newHttpBatchRpcSession(
      new Request(`${ORIGIN}/capnweb`, token ? { headers: bearer(token) } : undefined),
    ) as unknown as PetshopApi;
  return { session, posts };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

afterEach(() => vi.unstubAllGlobals());

describe("capnweb door", () => {
  test("HTTP batch: listPets / getPet / createPet for a valid bearer token, and the writes persist", async () => {
    const shop = makeShop();
    const token = await accessToken(shop);
    const { session } = capnwebClient(shop, token);

    const listed = await session().listPets();
    expect(listed.owner).toBe("Jonas");
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
    expect(posts[0].method).toBe("POST");
    expect(new URL(posts[0].url).pathname).toBe("/capnweb");
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
    expect(direct.status).toBe(401);
    expect(await direct.json()).toMatchObject({ error: "invalid_token" });

    const { session } = capnwebClient(shop);
    await expect(session().listPets()).rejects.toThrow(/401/);
  });

  test("GET /capnweb without an Upgrade is capnweb's 400, never a socket", async () => {
    const shop = makeShop();
    const token = await accessToken(shop);
    const response = await shop.call("/capnweb", { headers: bearer(token) });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/POST or WebSocket/);
  });

  test("the index documents the door", async () => {
    const shop = makeShop();
    const index = await (await shop.call("/")).text();
    expect(index).toContain("/capnweb");
  });
});
