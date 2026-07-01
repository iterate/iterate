// @ts-nocheck
import { describe, expect, test } from "vitest";

/*
 * Skipped call-site inventory for the simplified expression capability model.
 *
 * The implemented model is intentionally small:
 * - "live" keeps a concrete capability value in memory.
 * - "itx-expression" stores a durable recipe over project ITX.
 * - expression steps are either a getter segment or a method tuple:
 *     "streams"
 *     ["get", "/my/stream"]
 * - expression results may be plain capabilities or metadata-bearing provider packages:
 *     function | RpcTarget | nested object
 *     { instructions, types?, capability, flattenNestedPaths? }
 *     { capability, flattenNestedPaths: true }
 *
 * MCP/OpenAPI are the only built-ins with a reserved metadata convention:
 * connect(input) returns a callable RpcTarget with __describe(), then the same
 * fallback proxy still makes connect(input).someTool(...) work immediately.
 */
describe.skip("ITX expression capability call-site inventory", () => {
  test("MCP/OpenAPI connect targets describe themselves and still forward dynamic calls", async () => {
    using project = await root.projects.create({ slug: "expr-connect-builtins" });

    using docs = await project.mcp.connect({ url: "https://docs.example.com/mcp" });
    expect(await docs.__describe()).toEqual({
      instructions: expect.stringContaining("Call tools directly"),
      types: expect.stringContaining("search"),
    });
    await docs.search({ query: "Workers RPC" });

    using pets = await project.openapi.connect({
      specUrl: "https://pets.example.com/openapi.json",
    });
    expect(await pets.__describe()).toEqual({
      instructions: expect.stringContaining("operationId"),
      types: expect.stringContaining("findPetsByStatus"),
    });
    await pets.findPetsByStatus({ status: "available" });
  });

  test("durable MCP/OpenAPI mounts are expressions over connect", async () => {
    using project = await root.projects.create({ slug: "expr-mounted-builtins" });

    using docs = await project.provideCapability({
      expression: ["mcp", ["connect", { url: "https://docs.example.com/mcp" }]],
      path: ["docs"],
      type: "itx-expression",
    });
    using pets = await project.provideCapability({
      expression: ["openapi", ["connect", { specUrl: "https://pets.example.com/openapi.json" }]],
      path: ["pets"],
      type: "itx-expression",
    });

    await project.docs.search({ query: "Durable Objects RPC" });
    await project.pets.findPetsByStatus({ status: "available" });
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

  test("providers may return bare functions or capability packages", async () => {
    using project = await root.projects.create({ slug: "expr-functions" });
    const ref = inlineWorkerRef(`
      import { WorkerEntrypoint } from "cloudflare:workers";
      export class Worker extends WorkerEntrypoint {
        addFunction() {
          return (a, b) => a + b;
        }

        addPackage() {
          return {
            instructions: "Adds two numbers.",
            types: "export type Capability = (a: number, b: number) => Promise<number>;",
            capability: (a, b) => a + b,
          };
        }
      }
    `);

    using add = await project.provideCapability({
      expression: ["workers", ["get", ref], ["addFunction"]],
      path: ["add"],
      type: "itx-expression",
    });
    using addPackaged = await project.provideCapability({
      expression: ["workers", ["get", ref], ["addPackage"]],
      path: ["addPackaged"],
      type: "itx-expression",
    });

    expect(await project.add(20, 22)).toBe(42);
    expect(await project.addPackaged(20, 22)).toBe(42);
    await add.revoke();
    await addPackaged.revoke();
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
