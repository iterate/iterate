// OpenApiClient e2e: any OpenAPI API as an ergonomic capability, proven
// against the deployment's OWN deterministic fixture (debug-routes.ts) — a
// spec document plus the API it describes, admin-gated, so nothing here
// depends on a live third-party demo server. Claims:
//
//   1. flat operationId dispatch — path + query + body merge into ONE input
//      object, through project egress (the fixture only answers with the
//      admin bearer from props.headers, so headers riding every call is
//      proven implicitly)
//   2. describe() carries spec-derived `types` with zero callsite ceremony —
//      the core's provide-time describeItx hook journaled them
//   3. listOperations() enumerates the surface
//   4. refusals are self-describing: unknown input keys on a body-less
//      operation list the valid params; nested paths point at operationIds
//
// One OPTIONAL live petstore smoke stays at the end, tolerant by design — a
// flaky public demo server must never fail CI.

import { expect, test } from "vitest";
import {
  adminApiSecret,
  baseUrl,
  connectGlobal,
  registerCreatedProjectCleanup,
} from "./e2e-env.ts";

const createdProjectIds = registerCreatedProjectCleanup();

test(
  "OpenApiClient: deterministic fixture — typed dispatch, derived types, instructive refusals",
  { timeout: 120_000 },
  async () => {
    using itx = connectGlobal();
    const project = (await itx.projects.create({
      slug: `itx-openapi-${crypto.randomUUID().slice(0, 8)}`,
    })) as { id: string };
    createdProjectIds.push(project.id);
    using projectItx = await itx.projects.get(project.id);

    await projectItx.provideCapability({
      name: "fixture",
      capability: {
        entrypoint: "OpenApiClient",
        props: {
          headers: { authorization: `Bearer ${adminApiSecret()}` },
          specUrl: new URL("/api/itx/openapi-fixture/openapi.json", baseUrl()).toString(),
        },
        type: "rpc",
        worker: { type: "loopback" },
      },
    });

    // (2) ONE provide is enough: the loopback probe deadline absorbs the
    // cold project chain (itx.ts SELF_DESCRIPTION_LOOPBACK_TIMEOUT_MS), so
    // the journaled meta carries the spec-derived surface immediately.
    const entry = (await projectItx.describe()).capabilities.find(
      (candidate) => candidate.name === "fixture",
    ) as { instructions?: string; types?: string };
    expect(entry.types).toContain(
      "declare function getPet(input: { petId: number }): " +
        "Promise<{ id: number; name: string; tag?: string }>;",
    );
    expect(entry.types).toContain(
      'declare function listPets(input: { status: "available" | "pending" | "sold"; limit?: number })',
    );
    expect(entry.instructions ?? "").toContain("Itx OpenAPI Fixture");

    const handle = projectItx as never as Record<string, any>;

    // (1) path params, query params, and a JSON body — all deterministic.
    await expect(handle.fixture.getPet({ petId: 7 })).resolves.toEqual({
      id: 7,
      name: "pet-7",
    });
    await expect(handle.fixture.listPets({ limit: 1, status: "available" })).resolves.toEqual([
      { id: 1, name: "available-pet-1", tag: "available" },
    ]);
    await expect(handle.fixture.createPet({ name: "rex", tag: "dog" })).resolves.toEqual({
      id: 99,
      name: "rex",
      tag: "dog",
    });

    // (3) listOperations is the reserved discovery door.
    const operations = (await handle.fixture.listOperations()) as Array<{
      method: string;
      operationId: string;
      path: string;
    }>;
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "get", operationId: "getPet", path: "/pets/{petId}" }),
        expect.objectContaining({ method: "get", operationId: "listPets", path: "/pets" }),
        expect.objectContaining({ method: "post", operationId: "createPet", path: "/pets" }),
      ]),
    );

    // (4) self-describing refusals.
    await expect(handle.fixture.getPet({ bogus: true, petId: 7 })).rejects.toThrow(
      /unknown input key "bogus" — valid params: petId/,
    );
    await expect(handle.fixture.pets.getPet({ petId: 1 })).rejects.toThrow(
      /Call operations by operationId only/,
    );
  },
);

const PETSTORE_SPEC_URL = "https://petstore3.swagger.io/api/v3/openapi.json";

test(
  "optional live petstore smoke (tolerant: a public demo server never fails CI)",
  {
    timeout: 60_000,
  },
  async () => {
    using itx = connectGlobal();
    const project = (await itx.projects.create({
      slug: `itx-petstore-${crypto.randomUUID().slice(0, 8)}`,
    })) as { id: string };
    createdProjectIds.push(project.id);
    using projectItx = await itx.projects.get(project.id);

    try {
      await projectItx.provideCapability({
        name: "petstore",
        capability: {
          entrypoint: "OpenApiClient",
          props: { specUrl: PETSTORE_SPEC_URL },
          type: "rpc",
          worker: { type: "loopback" },
        },
      });
      const handle = projectItx as never as Record<string, any>;
      const pets = (await handle.petstore.findPetsByStatus({ status: "available" })) as unknown[];
      expect(Array.isArray(pets)).toBe(true);
    } catch (error) {
      console.warn(
        "live petstore smoke skipped (demo server unavailable):",
        error instanceof Error ? error.message : String(error),
      );
    }
  },
);
