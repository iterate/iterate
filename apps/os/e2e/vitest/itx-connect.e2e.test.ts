import { expect, test } from "vitest";
import type { DynamicWorkerRef } from "../../src/domains/workers/schemas.ts";
import { appendEvents } from "../test-support/append-events.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { startMockMcp, startMockOpenApi } from "./itx-capability-fixtures.ts";
import { inlineJsSource } from "./itx-test-support.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// These are hand written tests - they MUST pass
test("OpenAPI built-in connects directly and mounts as a described capability", async () => {
  const secretMaterial = "openapi-secret";
  const api = await startMockOpenApi({ expectedAuthorization: `Bearer ${secretMaterial}` });
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  try {
    using project = itx.projects.create({ slug: `openapi-${crypto.randomUUID()}` });
    const secretPath = `/secrets/openapi/${crypto.randomUUID()}`;
    using secret = project.secrets.get(secretPath);
    await secret.update({
      egress: { urls: [api.url] },
      material: secretMaterial,
    });
    await waitForCondition(async () => (await secret.__describe()).hasMaterial, {
      description: "OpenAPI secret to be available",
      // Secret DO folds the update asynchronously; the 5s default flaked on
      // cold slots under full-suite CI load.
      timeoutMs: 30_000,
    });

    const headers = { authorization: `Bearer getSecret({ path: "${secretPath}" })` };
    const specUrl = `${api.url}/openapi.json`;

    // Three call shapes exercised DELIBERATELY: pipelined on the un-awaited
    // connect() promise, on an awaited handle, and as a one-expression
    // chain — all three lanes must keep working.
    const directPromise = project.openapi.connect({ headers, specUrl });
    await expect(
      // @ts-expect-error - OpenAPI operations are derived at runtime.
      directPromise.findPetsByStatus({ status: "pipelined" }),
    ).resolves.toEqual([{ id: 1, name: "pipelined-pet", status: "pipelined" }]);
    const direct = await directPromise;
    await expect(
      // @ts-expect-error - OpenAPI operations are derived at runtime.
      direct.findPetsByStatus({ status: "available" }),
    ).resolves.toEqual([{ id: 1, name: "available-pet", status: "available" }]);
    await expect(
      // @ts-expect-error - OpenAPI operations are derived at runtime.
      project.openapi.connect({ headers, specUrl }).findPetsByStatus({
        status: "sold",
      }),
    ).resolves.toEqual([{ id: 1, name: "sold-pet", status: "sold" }]);

    // Refusals are self-describing: an unknown input key names the valid params.
    await expect(
      // @ts-expect-error - OpenAPI operations are derived at runtime.
      direct.findPetsByStatus({ status: "available", bogus: true }),
    ).rejects.toThrow(/unknown input key "bogus" — valid params: status/);

    const instructions = "Tiny Pets: call operationIds directly through the mounted capability.";
    const types =
      "export type Capability = { findPetsByStatus(input: { status: string }): Promise<unknown> };";
    // Metadata belongs to the capability-provided event. The connect target is
    // only the callable capability value.
    using _provision = await project.provideCapability({
      expression: ["openapi", ["connect", { headers, specUrl }]],
      instructions,
      path: ["pets"],
      type: "itx-expression",
      types,
    });
    const described = await project.__describe();
    expect(described).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          instructions,
          path: ["pets"],
          type: "itx-expression",
          types,
        }),
      ]),
    });
    await expect(
      // @ts-expect-error - mounted OpenAPI capability root.
      project.pets.findPetsByStatus({ status: "pending" }),
    ).resolves.toEqual([{ id: 1, name: "pending-pet", status: "pending" }]);

    if (api.authHeaders.length > 0) {
      expect(api).toMatchObject({
        authHeaders: expect.arrayContaining([`Bearer ${secretMaterial}`]),
      });
    }
  } finally {
    await api.close();
  }
});

test("MCP built-in connects directly and mounts as a described capability", async () => {
  const secretMaterial = "mcp-secret";
  const mcp = await startMockMcp({ expectedAuthorization: `Bearer ${secretMaterial}` });
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  try {
    using project = itx.projects.create({ slug: `mcp-${crypto.randomUUID()}` });
    const secretPath = `/secrets/mcp/${crypto.randomUUID()}`;
    using secret = project.secrets.get(secretPath);
    await secret.update({
      egress: { urls: [mcp.url] },
      material: secretMaterial,
    });
    await waitForCondition(async () => (await secret.__describe()).hasMaterial, {
      description: "MCP secret to be available",
    });

    const headers = { authorization: `Bearer getSecret({ path: "${secretPath}" })` };

    // Same three-lane coverage as the OpenAPI test above: un-awaited
    // promise, awaited handle, one-expression chain.
    const directPromise = project.mcp.connect({ headers, url: mcp.url });
    await expect(
      // @ts-expect-error - MCP tools are derived at runtime.
      directPromise.search_docs({ query: "Pipelined" }),
    ).resolves.toEqual({ answer: "docs:Pipelined" });
    const direct = await directPromise;
    await expect(
      // @ts-expect-error - MCP tools are derived at runtime.
      direct.search_docs({ query: "Workers" }),
    ).resolves.toEqual({ answer: "docs:Workers" });
    await expect(
      // @ts-expect-error - MCP tools are derived at runtime.
      project.mcp.connect({ headers, url: mcp.url }).search_docs({
        query: "Pipelines",
      }),
    ).resolves.toEqual({ answer: "docs:Pipelines" });

    const instructions = "Call search_docs on the mounted MCP docs capability.";
    const types =
      "export type Capability = { search_docs(input: { query: string }): Promise<unknown> };";
    // "docs" itself is a builtin (the docs door), so the mount must live
    // under a free name — provide-time collision rejection covers the rest.
    using _provision = await project.provideCapability({
      expression: ["mcp", ["connect", { headers, url: mcp.url }]],
      instructions,
      path: ["cloudflareDocs"],
      type: "itx-expression",
      types,
    });
    const described = await project.__describe();
    expect(described).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          instructions,
          path: ["cloudflareDocs"],
          type: "itx-expression",
          types,
        }),
      ]),
    });
    await expect(
      // @ts-expect-error - mounted MCP capability root.
      project.cloudflareDocs.search_docs({ query: "Durable Objects" }),
    ).resolves.toEqual({ answer: "docs:Durable Objects" });

    if (mcp.methods.length > 0) {
      expect(mcp).toMatchObject({ methods: expect.arrayContaining(["initialize", "tools/call"]) });
      expect(mcp.methods).not.toContain("tools/list");
    }
    if (mcp.authHeaders.length > 0) {
      expect(mcp).toMatchObject({
        authHeaders: expect.arrayContaining([`Bearer ${secretMaterial}`]),
      });
    }
  } finally {
    await mcp.close();
  }
});

test("itx expression capabilities mount MCP and OpenAPI built-ins through connect()", async () => {
  const secretMaterial = "expr-secret";
  const api = await startMockOpenApi({ expectedAuthorization: `Bearer ${secretMaterial}` });
  const mcp = await startMockMcp({ expectedAuthorization: `Bearer ${secretMaterial}` });
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  try {
    using project = itx.projects.create({ slug: `expr-builtins-${crypto.randomUUID()}` });
    const secretPath = `/secrets/expr-builtins/${crypto.randomUUID()}`;
    using secret = project.secrets.get(secretPath);
    await secret.update({
      egress: { urls: [api.url, mcp.url] },
      material: secretMaterial,
    });
    await waitForCondition(async () => (await secret.__describe()).hasMaterial, {
      description: "expression built-in secret to be available",
    });

    const headers = { authorization: `Bearer getSecret({ path: "${secretPath}" })` };
    const petsInstructions = "Tiny Pets expression mount: call findPetsByStatus with a status.";
    const petsTypes =
      "export type Capability = { findPetsByStatus(input: { status: string }): Promise<unknown> };";
    const docsInstructions = "Docs expression mount: call search_docs with a query.";
    const docsTypes =
      "export type Capability = { search_docs(input: { query: string }): Promise<unknown> };";
    using _petsProvision = await project.provideCapability({
      expression: [
        "openapi",
        [
          "connect",
          {
            headers,
            specUrl: `${api.url}/openapi.json`,
          },
        ],
      ],
      instructions: petsInstructions,
      path: ["exprPets"],
      type: "itx-expression",
      types: petsTypes,
    });
    using _docsProvision = await project.provideCapability({
      expression: ["mcp", ["connect", { headers, url: mcp.url }]],
      instructions: docsInstructions,
      path: ["exprDocs"],
      type: "itx-expression",
      types: docsTypes,
    });

    const described = await project.__describe();
    expect(described).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          instructions: petsInstructions,
          path: ["exprPets"],
          type: "itx-expression",
          types: petsTypes,
        }),
        expect.objectContaining({
          instructions: docsInstructions,
          path: ["exprDocs"],
          type: "itx-expression",
          types: docsTypes,
        }),
      ]),
    });

    await expect(
      // @ts-expect-error - mounted expression capability root.
      project.exprPets.findPetsByStatus({ status: "available" }),
    ).resolves.toEqual([{ id: 1, name: "available-pet", status: "available" }]);
    await expect(
      // @ts-expect-error - mounted expression capability root.
      project.exprDocs.search_docs({ query: "Expressions" }),
    ).resolves.toEqual({ answer: "docs:Expressions" });
  } finally {
    await api.close();
    await mcp.close();
  }
});

test("itx expression capabilities mount project workers, streams, method aliases, and functions", async () => {
  const marker = crypto.randomUUID();
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `expr-project-${crypto.randomUUID()}` });

  const workerRef = {
    entrypoint: "Worker",
    path: "/",
    source: inlineJsSource("worker.js", {
      "worker.js": `
          import { WorkerEntrypoint } from "cloudflare:workers";

          export class Worker extends WorkerEntrypoint {
            echo(input) {
              return { input, via: "expression-worker" };
            }

            addFunction() {
              return (left, right) => left + right;
            }

            invokeCapability({ args, path }) {
              return { args, path, via: "flattened-expression-worker" };
            }
          }
        `,
    }),
    type: "stateless",
  } satisfies DynamicWorkerRef;

  using _workerProvision = await project.provideCapability({
    expression: ["workers", ["get", workerRef]],
    instructions: "Echoes through a worker expression.",
    path: ["exprWorker"],
    type: "itx-expression",
    types: "export type Capability = { echo(input: unknown): Promise<unknown> };",
  });
  await expect(
    // @ts-expect-error - mounted expression capability root.
    project.exprWorker.echo({ ok: true }),
  ).resolves.toEqual({ input: { ok: true }, via: "expression-worker" });

  using _flatWorkerProvision = await project.provideCapability({
    expression: ["workers", ["get", workerRef]],
    flattenNestedPaths: true,
    path: ["exprFlatWorker"],
    type: "itx-expression",
  });
  await expect(
    // @ts-expect-error - mounted expression worker with flattened dispatch.
    project.exprFlatWorker.tools.echo("hello"),
  ).resolves.toEqual({
    args: ["hello"],
    path: ["tools", "echo"],
    via: "flattened-expression-worker",
  });

  using _functionProvision = await project.provideCapability({
    expression: ["workers", ["get", workerRef], ["addFunction"]],
    path: ["exprAdd"],
    type: "itx-expression",
  });
  await expect(
    // @ts-expect-error - mounted expression function root.
    project.exprAdd(20, 22),
  ).resolves.toBe(42);

  using _streamProvision = await project.provideCapability({
    expression: ["streams", ["get", "/expr/special/stream"]],
    path: ["mySpecialStream"],
    type: "itx-expression",
  });
  // @ts-expect-error - mounted expression stream root.
  const [event] = await appendEvents(project.mySpecialStream, {
    payload: { ok: true },
    type: "events.iterate.test/itx-expression-stream",
  });
  // oxlint-disable-next-line iterate/prefer-object-property-match -- exact round-trip: the appended payload must come back untouched
  expect(event.payload).toEqual({ ok: true });

  using _sourceProvision = await project.provideCapability({
    capability: {
      deeper: {
        path: {
          someMethod(input: string) {
            return `aliased:${input}`;
          },
        },
      },
    },
    path: ["exprSource"],
    type: "live",
  });
  using _aliasProvision = await project.provideCapability({
    expression: ["exprSource", "deeper", "path", "someMethod"],
    path: ["exprSomeMethod"],
    type: "itx-expression",
  });
  await expect(
    // @ts-expect-error - mounted expression method root.
    project.exprSomeMethod("ok"),
  ).resolves.toBe("aliased:ok");

  using _factoryProvision = await project.provideCapability({
    capability: {
      makeDomainObject() {
        return {
          capability: {
            echo(input: string) {
              return `domain:${input}`;
            },
          },
          instructions: "literal data, not capability metadata",
          status() {
            return `status:${marker}`;
          },
          types: "literal data, not capability metadata",
        };
      },
    },
    path: ["exprFactory"],
    type: "live",
  });
  using _domainObjectProvision = await project.provideCapability({
    expression: ["exprFactory", ["makeDomainObject"]],
    path: ["exprDomainObject"],
    type: "itx-expression",
  });

  await expect(
    // @ts-expect-error - mounted expression object root.
    project.exprDomainObject.status(),
  ).resolves.toBe(`status:${marker}`);
  await expect(
    // @ts-expect-error - mounted expression object root.
    project.exprDomainObject.capability.echo("ok"),
  ).resolves.toBe("domain:ok");

  const description = await project.__describe();
  const domainObjectDescription = description.capabilities.find((capability) =>
    capability.path.every((segment, index) => segment === ["exprDomainObject"][index]),
  );
  expect(domainObjectDescription).toMatchObject({
    path: ["exprDomainObject"],
    type: "itx-expression",
  });
  expect(domainObjectDescription?.instructions).toBeUndefined();
  expect(domainObjectDescription?.types).toBeUndefined();
});

test("itx expression capabilities resolve aliases against the current itx host path", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `expr-agent-${crypto.randomUUID()}` });
  const agentPath = `/agents/expr-agent-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);

  using _sourceProvision = await agent.provideCapability({
    capability: {
      deeper: {
        path: {
          someMethod(input: string) {
            return `agent-aliased:${input}`;
          },
        },
      },
    },
    path: ["exprSource"],
    type: "live",
  });
  using _aliasProvision = await agent.provideCapability({
    expression: ["exprSource", "deeper", "path", "someMethod"],
    path: ["exprAgentSomeMethod"],
    type: "itx-expression",
  });

  await expect(
    // #1839 de-proxied the agent handle: a scope's dynamic capabilities
    // live behind its capabilityHost property, not on the handle itself.
    // @ts-expect-error - mounted agent expression method root.
    agent.capabilityHost.exprAgentSomeMethod("ok"),
  ).resolves.toBe("agent-aliased:ok");
  await expect(
    // @ts-expect-error - proves the alias was mounted on the agent host, not project root.
    project.exprAgentSomeMethod("project should not see this"),
  ).rejects.toThrow(/no capability "exprAgentSomeMethod"/);
});

test("itx expression capabilities reject self-aliases at provide time", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `expr-self-${crypto.randomUUID()}` });

  await expect(
    project.provideCapability({
      expression: ["selfAlias"],
      path: ["selfAlias"],
      type: "itx-expression",
    }),
  ).rejects.toThrow(/cannot reference its own mount path/);
  await expect(
    project.provideCapability({
      expression: ["nested", "selfAlias", "extra"],
      path: ["nested", "selfAlias"],
      type: "itx-expression",
    }),
  ).rejects.toThrow(/cannot reference its own mount path/);
});
