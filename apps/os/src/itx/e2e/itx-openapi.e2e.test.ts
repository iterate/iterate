// OpenApiClient e2e: any OpenAPI API as an ergonomic capability, proven
// against the public Swagger petstore demo. Three claims:
//
//   1. itx.petstore.findPetsByStatus({ status }) — flat operationId
//      dispatch, ONE merged input object, through project egress
//   2. describe() carries spec-derived `types` with zero callsite ceremony —
//      the core's provide-time describeItx hook journaled them
//   3. listOperations() enumerates the surface
//
// petstore3.swagger.io is a live demo server: assertions stay tolerant
// (shapes, not data), and the provide is retried because the very first
// describeItx probe races a cold project DO chain against the hook's
// few-second best-effort deadline.

import { expect, test } from "vitest";
import { connectGlobal, registerCreatedProjectCleanup } from "./e2e-env.ts";

const SPEC_URL = "https://petstore3.swagger.io/api/v3/openapi.json";

const createdProjectIds = registerCreatedProjectCleanup();

test(
  "OpenApiClient: ergonomic calls + spec-derived types in describe() + listOperations",
  { timeout: 120_000 },
  async () => {
    using itx = connectGlobal();
    const project = (await itx.projects.create({
      slug: `itx-openapi-${crypto.randomUUID().slice(0, 8)}`,
    })) as { id: string };
    createdProjectIds.push(project.id);
    using projectItx = await itx.projects.get(project.id);

    const provide = async () => {
      await projectItx.provideCapability({
        name: "petstore",
        capability: {
          entrypoint: "OpenApiClient",
          props: { specUrl: SPEC_URL },
          type: "rpc",
          worker: { type: "loopback" },
        },
      });
      const description = await projectItx.describe();
      return description.capabilities.find((entry) => entry.name === "petstore") as
        | { instructions?: string; types?: string }
        | undefined;
    };

    // (2) first: the provide-time hook fills types + instructions from the
    // spec. Re-provide until the probe beats its deadline (cold start: spec
    // fetch + isolate spin-up can exceed it once; the spec memo makes the
    // next attempt instant).
    await expect
      .poll(async () => (await provide())?.types ?? "", { interval: 2_000, timeout: 90_000 })
      .toContain("declare function findPetsByStatus");
    const entry = (await projectItx.describe()).capabilities.find(
      (candidate) => candidate.name === "petstore",
    ) as { instructions?: string; types?: string };
    // A plausible response type, not just the name: findPetsByStatus takes
    // the status enum and returns Pet[] — an object array carrying `name`.
    expect(entry.types).toContain(
      'declare function findPetsByStatus(input: { status: "available" | "pending" | "sold" })',
    );
    expect(entry.types).toMatch(/findPetsByStatus.*Promise<\{ .*name: string.* \}\[\]>;/);
    // The instructions default names the API (the spec's info.title).
    expect(entry.instructions ?? "").toContain("Swagger Petstore");

    const handle = projectItx as never as Record<string, any>;

    // (1) the ergonomic call, through egress, against the live demo.
    const pets = (await handle.petstore.findPetsByStatus({ status: "available" })) as unknown[];
    expect(Array.isArray(pets)).toBe(true);

    // (3) listOperations is the reserved discovery door.
    const operations = (await handle.petstore.listOperations()) as Array<{
      method: string;
      operationId: string;
      path: string;
    }>;
    expect(operations.length).toBeGreaterThan(5);
    expect(operations).toContainEqual(
      expect.objectContaining({
        method: "get",
        operationId: "findPetsByStatus",
        path: "/pet/findByStatus",
      }),
    );

    // Path-param dispatch: getPetById({ petId }) resolves /pet/{petId}. The
    // demo dataset shifts constantly, so accept the data OR the API's own
    // 404 — what matters is that the operation routed and the path resolved.
    if (pets.length > 0) {
      const petId = (pets[0] as { id?: number }).id;
      if (petId != null) {
        const pet = await handle.petstore
          .getPetById({ petId })
          .catch((error: Error) => error.message);
        if (typeof pet === "string") {
          expect(pet).toMatch(/getPetById|returned 404/);
        } else {
          expect(pet).toMatchObject({ id: petId });
        }
      }
    }
  },
);
