// Facet caps + HTTP routing (itx/http.ts):
//
//   facet caps   stored source exporting `extends DurableObject`, instantiated
//                as a Durable Object Facet of the hosting context node — its
//                own private SQLite database, zero provisioning
//   cap hosts    {cap}--{project}.{base} routes to the cap's fetch surface;
//                exposed caps are public, unexposed caps don't exist (404)

import { expect, test } from "vitest";
import { connectGlobal, createItxProject, registerCreatedProjectCleanup } from "./e2e-env.ts";

const createdProjectIds = registerCreatedProjectCleanup();

test("facet caps keep private durable state across invocations", async () => {
  using itx = connectGlobal();
  const project = (await createItxProject(itx, { slug: `itx-facet-${suffix()}` })) as {
    id: string;
  };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  await projectItx.provideCapability({
    name: "counter",
    capability: {
      type: "rpc",
      worker: {
        type: "source",
        source: {
          type: "inline",
          cacheKey: crypto.randomUUID(),
          // Facet classes must be NAMED exports (default exports trip an opaque
          // workerd error — the core validates this at provide time).
          entrypoint: "Counter",
          exportType: "durable-object",
          mainModule: "cap.js",
          modules: {
            "cap.js": `
              import { DurableObject } from "cloudflare:workers";
              export class Counter extends DurableObject {
                async increment() {
                  const count = ((await this.ctx.storage.get("count")) ?? 0) + 1;
                  await this.ctx.storage.put("count", count);
                  return count;
                }
                async current() {
                  return (await this.ctx.storage.get("count")) ?? 0;
                }
              }
            `,
          },
        },
      },
    },
  });

  const counter = (projectItx as never as Record<string, any>).counter;
  await expect(counter.increment()).resolves.toBe(1);
  await expect(counter.increment()).resolves.toBe(2);
  await expect(counter.current()).resolves.toBe(2);
});

test("HTTP-exposed caps serve their own hostname publicly; unexposed caps 404", async () => {
  using itx = connectGlobal();
  const slug = `itx-http-${suffix()}`;
  const project = (await createItxProject(itx, { slug })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  await projectItx.provideCapability({
    meta: { http: { expose: true } },
    name: "hello",
    capability: {
      type: "rpc",
      worker: {
        type: "source",
        source: {
          type: "inline",
          cacheKey: crypto.randomUUID(),
          mainModule: "cap.js",
          modules: {
            "cap.js": `
              import { WorkerEntrypoint } from "cloudflare:workers";
              export default class extends WorkerEntrypoint {
                async fetch(request) {
                  const url = new URL(request.url);
                  return new Response("hello from a routable cap at " + url.pathname, {
                    headers: { "content-type": "text/plain" },
                  });
                }
              }
            `,
          },
        },
      },
    },
  });

  // Cast: the deeply-stubified DurableObjectStub type sends tsc into
  // excessively-deep instantiation when chained off the Itx stub.
  const projectAdmin = (projectItx as unknown as { project: unknown }).project as {
    ingressUrl(): Promise<string>;
  };
  const ingress = new URL(await projectAdmin.ingressUrl());
  const capUrl = new URL(ingress);
  capUrl.hostname = `hello--${ingress.hostname}`;

  // (1) Exposed = public: anonymous requests reach the cap's fetch surface.
  const anonymous = await fetch(new URL("/demo", capUrl));
  expect(anonymous.status).toBe(200);
  await expect(anonymous.text()).resolves.toContain("hello from a routable cap at /demo");

  // (2) Unexposed caps do not exist as hostnames at all.
  await projectItx.provideCapability({
    name: "internal",
    capability: {
      type: "rpc",
      worker: {
        type: "source",
        source: {
          type: "inline",
          cacheKey: crypto.randomUUID(),
          mainModule: "cap.js",
          modules: {
            "cap.js": `
              import { WorkerEntrypoint } from "cloudflare:workers";
              export default class extends WorkerEntrypoint {
                async fetch() { return new Response("should never be reachable"); }
              }
            `,
          },
        },
      },
    },
  });
  const internalUrl = new URL(ingress);
  internalUrl.hostname = `internal--${ingress.hostname}`;
  const internal = await fetch(internalUrl);
  expect(internal.status).toBe(404);
});

// ---- helpers ----------------------------------------------------------------

function suffix() {
  return crypto.randomUUID().slice(0, 8);
}
