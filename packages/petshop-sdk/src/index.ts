// The pet shop's own SDK, as a vendor would ship one: its capnweb pets API (apps/dummy-petshop
// src/capnweb.ts), typed. A project's worker installs it like any npm package and calls the shop
// with the account's bearer token; the fetch it makes is the worker's own, so on Iterate it goes out
// through the project's egress.
import { newHttpBatchRpcSession, type RpcStub } from "@iterate-com/capnweb";

/** One pet in the shop's catalogue. */
export type Pet = { id: string; name: string; species: string };

/** The shop's capnweb API for one authenticated account. */
export interface PetshopApi {
  /** The account's pets, and whose they are. */
  listPets(): { owner: string; pets: Pet[] };
  /** One pet by id; an unknown id throws. */
  getPet(id: string): Pet;
  /** Add a pet to the account. */
  createPet(input: { name: string; species: string }): Pet;
}

/** The deployed pet shop. */
export const PETSHOP_BASE_URL = "https://dummy-petshop.iterate.workers.dev";

/**
 * The shop's API for the account `token` belongs to, as one capnweb HTTP batch: every call made
 * before the first `await` rides one request (`api.listPets()` and `api.getPet("pet-1")` together
 * cost one round trip). A batch serves one round of calls, so connect again for the next.
 */
export function connectPetshop(options: { token: string; baseUrl?: string }): RpcStub<PetshopApi> {
  const baseUrl = (options.baseUrl || PETSHOP_BASE_URL).replace(/\/$/, "");
  // oxlint-disable-next-line iterate/no-capnweb-http-batch -- A vendor SDK's one-round-trip read; no live capabilities cross it.
  return newHttpBatchRpcSession<PetshopApi>(
    new Request(`${baseUrl}/capnweb`, { headers: { Authorization: `Bearer ${options.token}` } }),
  );
}
