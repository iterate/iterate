// @ts-nocheck
import { describe, expect, test } from "vitest";

/*
 * Skipped call-site inventory for the simplified expression capability model.
 *
 * The implemented model is intentionally small:
 * - "live" keeps a concrete capability value in memory.
 * - "itx-expression" stores a durable recipe over project ITX.
 * - instructions, types, and flattenNestedPaths are metadata on the
 *   capability-provided event, never discovered from the returned capability.
 * - expression steps are either a getter segment or a method tuple:
 *     "streams"
 *     ["get", "/my/stream"]
 * - expression results are plain capability values:
 *     function | RpcTarget | nested object
 *
 * MCP/OpenAPI connect(input) return callable RpcTargets. The fallback proxy
 * still makes connect(input).someTool(...) work immediately, but any
 * instructions/types for a durable mount are supplied by provideCapability.
 */
describe.skip("ITX expression capability call-site inventory", () => {
  test("MCP/OpenAPI connect targets forward dynamic calls", async () => {
    using project = await root.projects.create({ slug: "expr-connect-builtins" });

    const docsPromise = project.mcp.connect({ url: "https://docs.example.com/mcp" });
    await docsPromise.search({ query: "Workers RPC" });
    using docs = await docsPromise;
    await docs.search({ query: "Workers RPC" });

    const petsPromise = project.openapi.connect({
      specUrl: "https://pets.example.com/openapi.json",
    });
    await petsPromise.findPetsByStatus({ status: "available" });
    using pets = await petsPromise;
    await pets.findPetsByStatus({ status: "available" });
  });

  test("durable MCP/OpenAPI mounts are expressions over connect with caller metadata", async () => {
    using project = await root.projects.create({ slug: "expr-mounted-builtins" });

    using docs = await project.provideCapability({
      expression: ["mcp", ["connect", { url: "https://docs.example.com/mcp" }]],
      instructions: "Search project documentation.",
      path: ["docs"],
      type: "itx-expression",
      types: "export type Capability = { search(input: { query: string }): Promise<unknown> };",
    });
    using pets = await project.provideCapability({
      expression: ["openapi", ["connect", { specUrl: "https://pets.example.com/openapi.json" }]],
      instructions: "Call petstore OpenAPI operations by operationId.",
      path: ["pets"],
      type: "itx-expression",
      types:
        "export type Capability = { findPetsByStatus(input: { status: string }): Promise<unknown> };",
    });

    await project.docs.search({ query: "Durable Objects RPC" });
    await project.pets.findPetsByStatus({ status: "available" });
    expect(await project.describe()).toEqual(
      expect.objectContaining({
        capabilities: expect.arrayContaining([
          expect.objectContaining({
            instructions: "Search project documentation.",
            path: ["docs"],
          }),
          expect.objectContaining({
            instructions: "Call petstore OpenAPI operations by operationId.",
            path: ["pets"],
          }),
        ]),
      }),
    );
    await docs.revoke();
    await pets.revoke();
  });

  test("dynamic workers are mounted through workers.get(ref)", async () => {
    using project = await root.projects.create({ slug: "expr-worker" });
    const ref = inlineWorkerRef(`
      import { WorkerEntrypoint } from "cloudflare:workers";
      export class Worker extends WorkerEntrypoint {
        echo(input) {
          return { input, via: "worker-expression" };
        }
      }
    `);

    using worker = await project.provideCapability({
      expression: ["workers", ["get", ref]],
      instructions: "Echoes its input.",
      path: ["workerTool"],
      type: "itx-expression",
      types: "export type Capability = { echo(input: unknown): Promise<unknown> };",
    });

    await project.workerTool.echo({ ok: true });
    await worker.revoke();
  });

  test("live capability values are literal even when they have a capability member", async () => {
    using project = await root.projects.create({ slug: "expr-live-target-literal" });

    using tools = await project.provideCapability({
      path: ["tools"],
      capability: {
        capability: {
          echo(input) {
            return input;
          },
        },
        status() {
          return "ok";
        },
      },
      type: "live",
    });

    await project.tools.status();
    await project.tools.capability.echo("ok");
    await tools.revoke();
  });

  test("anything on project ITX can be mounted, including stream handles", async () => {
    using project = await root.projects.create({ slug: "expr-stream" });

    using stream = await project.provideCapability({
      expression: ["streams", ["get", "/my/special/stream"]],
      path: ["mySpecialStream"],
      type: "itx-expression",
    });

    await project.mySpecialStream.append({
      payload: { ok: true },
      type: "events.iterate.test/special",
    });
    await stream.revoke();
  });

  test("method aliases preserve receiver state", async () => {
    using project = await root.projects.create({ slug: "expr-method-alias" });

    using source = await project.provideCapability({
      capability: {
        deeper: {
          path: {
            prefix: "receiver-state",
            someMethod(input) {
              return `${this.prefix}:${input}`;
            },
          },
        },
      },
      path: ["some"],
      type: "live",
    });
    using alias = await project.provideCapability({
      expression: ["some", "deeper", "path", "someMethod"],
      path: ["someMethod"],
      type: "itx-expression",
    });

    expect(await project.someMethod("ok")).toBe("receiver-state:ok");
    await alias.revoke();
    await source.revoke();
  });

  test("providers may return bare functions, and capability fields are literal", async () => {
    using project = await root.projects.create({ slug: "expr-functions" });
    const ref = inlineWorkerRef(`
      import { WorkerEntrypoint } from "cloudflare:workers";
      export class Worker extends WorkerEntrypoint {
        addFunction() {
          return (a, b) => a + b;
        }

        objectWithCapabilityField() {
          return {
            capability: {
              echo(input) {
                return input;
              },
            },
            instructions: "literal data, not metadata",
          };
        }
      }
    `);

    using add = await project.provideCapability({
      expression: ["workers", ["get", ref], ["addFunction"]],
      path: ["add"],
      type: "itx-expression",
    });
    using literal = await project.provideCapability({
      expression: ["workers", ["get", ref], ["objectWithCapabilityField"]],
      path: ["literal"],
      type: "itx-expression",
    });

    expect(await project.add(20, 22)).toBe(42);
    expect(await project.literal.capability.echo("ok")).toBe("ok");
    expect(await project.describe()).toEqual(
      expect.objectContaining({
        capabilities: expect.arrayContaining([
          expect.objectContaining({
            path: ["literal"],
            type: "itx-expression",
          }),
        ]),
      }),
    );
    await add.revoke();
    await literal.revoke();
  });
});

function inlineWorkerRef(mainModule) {
  return {
    entrypoint: "Worker",
    path: "/",
    source: {
      mainModule: "main.js",
      modules: { "main.js": mainModule },
      type: "inline",
    },
    type: "stateless",
  };
}
