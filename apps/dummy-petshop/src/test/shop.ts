import { seedPets } from "../pets.ts";
import { randomSealKey } from "../seal.ts";
import { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET, PetshopStateDurableObject } from "../state.ts";
import { handlePetshopRequest, type PetshopDeps } from "../worker.ts";

export const ORIGIN = "https://petshop.example";

/**
 * One shop "environment": the real route handlers and the real state class over
 * an in-memory storage fake. `call` drives it by path+init; `fetch` drives it by
 * a whole Request (what an oRPC or capnweb client hands over). Both hit the same
 * deps, so a client's writes are visible to later `call`s.
 */
export function makeShop(options: { backdoorSecret?: string } = {}) {
  const blobs = new Map<string, unknown>();
  // Clone on both sides like real DO storage does, so nothing survives by
  // reference identity.
  const storage = {
    get: async (key: string) => structuredClone(blobs.get(key)),
    put: async (key: string, value: unknown) => void blobs.set(key, structuredClone(value)),
  };
  const deps: PetshopDeps = {
    state: new PetshopStateDurableObject({ storage } as unknown as DurableObjectState, {}),
    sealKey: randomSealKey(),
    backdoorSecret: options.backdoorSecret,
    pets: seedPets(),
  };
  return {
    call: (path: string, init?: RequestInit) =>
      handlePetshopRequest(new Request(`${ORIGIN}${path}`, init), deps),
    fetch: (request: Request) => handlePetshopRequest(request, deps),
  };
}

export type Shop = ReturnType<typeof makeShop>;

/** Run the full consent → code → token dance for the seeded client and return a live access token. */
export async function accessToken(shop: Shop): Promise<string> {
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
