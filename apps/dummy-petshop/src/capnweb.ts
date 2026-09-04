/**
 * The pet shop as a capnweb API, served at `/capnweb` — an HTTP batch (`POST`)
 * or a WebSocket session (`GET` + `Upgrade: websocket`), both answered by
 * capnweb's `newWorkersRpcResponse`. It exposes the same pets surface the oRPC
 * procedures (rpc.ts) and the MCP tools (mcp.ts) expose, as ONE RpcTarget a
 * client calls (and pipelines) directly:
 *
 *   - `listPets()`                    — the account's pets.
 *   - `getPet(id)`                    — one pet by id.
 *   - `createPet({ name, species })`  — add a pet to the account.
 *
 * Auth is, for now, the shop's ordinary bearer token in the `Authorization`
 * header — on the batch POST and on the WebSocket UPGRADE request alike: the
 * worker resolves it with `accessGrant` (worker.ts) before this handler runs,
 * exactly as it does for /mcp and /api/v2, and threads the authenticated owner
 * + request-scoped catalogue through. No in-band (capnweb-level) auth yet.
 *
 * This makes the pet shop a real remote capnweb API for the clean-room's
 * `itx.connectToCapnweb` library connector (packages/v3/project-worker).
 */
import { RpcTarget, newWorkersRpcResponse } from "capnweb";
import type { Pet } from "./pets.ts";

/**
 * The authenticated principal + request-scoped catalogue the API object is
 * built over — the same pair the MCP tools and the oRPC procedures receive.
 */
export interface CapnwebApiContext {
  owner: string;
  pets: Pet[];
}

/** The remote main object a capnweb client holds: the pets API for one authenticated owner. */
export class PetshopCapnwebApi extends RpcTarget {
  readonly #owner: string;
  readonly #pets: Pet[];

  constructor(context: CapnwebApiContext) {
    super();
    this.#owner = context.owner;
    this.#pets = context.pets;
  }

  /** The authenticated account's (entirely fictional) pets — the same answer as `GET /api/pets`. */
  listPets(): { owner: string; pets: Pet[] } {
    return { owner: this.#owner, pets: [...this.#pets] };
  }

  /** One pet by id; an unknown id throws, and the client sees the message. */
  getPet(id: string): Pet {
    const pet = this.#pets.find((candidate) => candidate.id === id);
    if (!pet) throw new Error(`No pet with id ${id}`);
    return pet;
  }

  /** Add a pet to the authenticated account. */
  createPet(input: { name: string; species: string }): Pet {
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    const species = typeof input?.species === "string" ? input.species.trim() : "";
    if (!name || !species) throw new Error("createPet needs a non-empty name and species");
    const pet: Pet = { id: `pet-${this.#pets.length + 1}`, name, species };
    this.#pets.push(pet);
    return pet;
  }
}

/**
 * Serve one capnweb request — a batch POST or a WebSocket upgrade — with the
 * authenticated owner + catalogue as the API object's context. The worker has
 * already verified the bearer token.
 */
export function handleCapnwebRequest(
  request: Request,
  context: CapnwebApiContext,
): Promise<Response> {
  return newWorkersRpcResponse(request, new PetshopCapnwebApi(context));
}
