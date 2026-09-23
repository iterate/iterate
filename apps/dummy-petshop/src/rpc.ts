/**
 * The pet shop's typed "pets" API, defined once as oRPC procedures and served
 * two ways from the one worker:
 *
 *   - `POST /rpc/*`      — the oRPC RPC protocol (what an @orpc/client talks).
 *   - `GET  /openapi.json` — an OpenAPI 3.1 document generated from the same
 *                            procedures, plus `GET|POST /api/v2/*` served
 *                            through the OpenAPI (REST-shaped) handler.
 *
 * Every procedure runs behind the same OAuth bearer check as the rest of the
 * shop: the worker resolves the request's access token with `accessGrant`
 * (worker.ts) and hands the resulting owner in as the oRPC context, so an
 * absent or dead token is a 401 before any procedure body runs.
 *
 * This is the shape that lets the pet shop be consumed as a real typed/OpenAPI
 * upstream by the OS outbound-integration work
 * (apps/os/docs/integrations-and-secrets-design.md).
 */
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { z } from "zod";
import type { Pet } from "./pets.ts";

/**
 * What every pets procedure is given: the authenticated owner (the `sub` from
 * the resolved access grant) and the request-scoped pet catalogue the shop
 * handler seeds. Injected via oRPC's `.handle(request, { context })`, so the
 * worker's bearer check runs before any procedure body.
 */
export interface PetsContext {
  owner: string;
  pets: Pet[];
}

const Pet = z.object({
  id: z.string().describe("Stable pet identifier, e.g. pet-1."),
  name: z.string().describe("The pet's name."),
  species: z.string().describe("The pet's species, e.g. beagle."),
});

const base = os.$context<PetsContext>();

const listPets = base
  .route({ method: "GET", path: "/pets", summary: "List the account's pets" })
  .output(z.object({ owner: z.string(), pets: z.array(Pet) }))
  .handler(({ context }) => ({ owner: context.owner, pets: context.pets }));

const getPet = base
  .route({ method: "GET", path: "/pets/{id}", summary: "Fetch one pet by id" })
  .input(z.object({ id: z.string().describe("The pet id to fetch.") }))
  .output(Pet)
  .handler(({ input, context }) => {
    const pet = context.pets.find((candidate) => candidate.id === input.id);
    if (!pet) throw new ORPCError("NOT_FOUND", { message: `No pet with id ${input.id}` });
    return pet;
  });

const createPet = base
  .route({ method: "POST", path: "/pets", summary: "Add a pet to the account" })
  .input(z.object({ name: z.string().min(1), species: z.string().min(1) }))
  .output(Pet)
  .handler(({ input, context }) => {
    const pet: Pet = {
      id: `pet-${context.pets.length + 1}`,
      name: input.name,
      species: input.species,
    };
    context.pets.push(pet);
    return pet;
  });

/** The pet shop's whole typed surface — the router both handlers and the OpenAPI generator read. */
export const petsRouter = { listPets, getPet, createPet };

// One converter/generator/handler set at module scope: they are pure over the
// router and only the per-request `context` varies (passed to `.handle`).
const openapiGenerator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});
const rpcHandler = new RPCHandler(petsRouter);
const openapiHandler = new OpenAPIHandler(petsRouter);

/** The generated OpenAPI 3.1 document for the pets procedures. */
export async function petshopOpenApiDocument(baseUrl: string) {
  return openapiGenerator.generate(petsRouter, {
    info: { title: "dummy-petshop pets API", version: "2.0.0" },
    servers: [{ url: `${baseUrl}/api/v2` }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    },
  });
}

/**
 * Serve an oRPC request against the pets router with the authenticated owner
 * as context. `mode` selects the protocol: `rpc` for `POST /rpc/*` (the
 * @orpc/client wire format) or `openapi` for the REST-shaped `/api/v2/*`
 * surface. Returns null when the handler didn't match the path, so the worker
 * can fall through to its 404.
 */
export async function handlePetsRpcRequest(
  request: Request,
  context: PetsContext,
  mode: "rpc" | "openapi",
): Promise<Response | null> {
  const { prefix, handler } =
    mode === "rpc"
      ? { prefix: "/rpc" as const, handler: rpcHandler }
      : { prefix: "/api/v2" as const, handler: openapiHandler };
  const { matched, response } = await handler.handle(request, { prefix, context });
  return matched ? response : null;
}
