/**
 * Unit tests for the pet shop's typed surfaces — the OpenAPI document, the
 * REST-shaped OpenAPI handler (/api/v2), and the oRPC RPC handler (/rpc) —
 * driven in plain Node against the real route handlers over the
 * test/shop.ts in-memory storage fake and the cloudflare:workers shim.
 * Hermetic — no network.
 */
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { describe, expect, test } from "vitest";
import type { petsRouter } from "./rpc.ts";
import { accessToken, makeShop, ORIGIN, type Shop } from "./test/shop.ts";

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("openapi.json", () => {
  test("is served for a valid token and lists the pet operations", async () => {
    const shop = makeShop();
    const token = await accessToken(shop);
    const response = await shop.call("/openapi.json", { headers: bearer(token) });
    expect(response.status).toBe(200);
    const doc = await response.json<{
      openapi: string;
      paths: Record<string, Record<string, { summary?: string }>>;
    }>();
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(doc.paths["/pets"].get.summary).toBe("List the account's pets");
    expect(doc.paths["/pets"].post.summary).toBe("Add a pet to the account");
    expect(doc.paths["/pets/{id}"].get.summary).toBe("Fetch one pet by id");
  });

  test("401 without a bearer token", async () => {
    const shop = makeShop();
    expect((await shop.call("/openapi.json")).status).toBe(401);
  });
});

describe("oRPC handler", () => {
  /** A typed @orpc/client wired to talk to the shop through /rpc, with a bearer header. */
  function client(shop: Shop, token: string): RouterClient<typeof petsRouter> {
    const link = new RPCLink({
      url: `${ORIGIN}/rpc`,
      headers: () => bearer(token),
      fetch: (request) => shop.fetch(request),
    });
    return createORPCClient(link);
  }

  test("returns the account's pets for a valid bearer token", async () => {
    const shop = makeShop();
    const token = await accessToken(shop);
    const orpc = client(shop, token);
    const listed = await orpc.listPets();
    expect(listed.owner).toBe("Jonas");
    expect(listed.pets.map((pet) => pet.name)).toEqual(["Biscuit", "Goldie"]);

    const one = await orpc.getPet({ id: "pet-2" });
    expect(one).toMatchObject({ name: "Goldie", species: "goldfish" });

    const created = await orpc.createPet({ name: "Rex", species: "terrier" });
    expect(created).toMatchObject({ id: "pet-3", name: "Rex" });
    expect((await orpc.listPets()).pets).toHaveLength(3);
  });

  test("401 without a bearer token", async () => {
    const shop = makeShop();
    const response = await shop.call("/rpc/listPets", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
  });
});

describe("OpenAPI (REST-shaped) handler", () => {
  test("GET /api/v2/pets returns pets for a valid token", async () => {
    const shop = makeShop();
    const token = await accessToken(shop);
    const response = await shop.call("/api/v2/pets", { headers: bearer(token) });
    expect(response.status).toBe(200);
    const body = await response.json<{ owner: string; pets: { name: string }[] }>();
    expect(body.owner).toBe("Jonas");
    expect(body.pets.map((pet) => pet.name)).toEqual(["Biscuit", "Goldie"]);
  });

  test("401 without a bearer token", async () => {
    const shop = makeShop();
    expect((await shop.call("/api/v2/pets")).status).toBe(401);
  });
});
