// Facet caps + HTTP routing (spec §8, phase 5):
//
//   facet caps   stored source exporting `extends DurableObject`, instantiated
//                as a Durable Object Facet of the hosting context node — its
//                own private SQLite database, zero provisioning
//   cap hosts    {cap}--{project}.{base} routes to the cap's fetch surface,
//                admin-gated by default, opt-in public, or via signed share URL

import { expect, test } from "vitest";
import { adminApiSecret, connectGlobal, registerCreatedProjectCleanup } from "./e2e-env.ts";

const createdProjectIds = registerCreatedProjectCleanup();

test("facet caps keep private durable state across invocations", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `itx-facet-${suffix()}` })) as { id: string };
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

test("HTTP-exposed caps serve their own hostname: admin, share URL, public", async () => {
  using itx = connectGlobal();
  const slug = `itx-http-${suffix()}`;
  const project = (await itx.projects.create({ slug })) as { id: string };
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

  // (1) Routable ≠ public: anonymous is rejected…
  const anonymous = await fetch(capUrl, { redirect: "manual" });
  expect(anonymous.status).toBe(401);

  // (2) …admin credentials pass…
  const admin = await fetch(capUrl, {
    headers: { authorization: `Bearer ${adminApiSecret()}` },
  });
  expect(admin.status).toBe(200);
  await expect(admin.text()).resolves.toContain("hello from a routable cap");

  // (3) …and a share URL admits whoever holds it, for one cap, until expiry.
  const shareUrl = String(await projectItx.shareUrl({ name: "hello", path: "/demo" }));
  const shared = await fetch(shareUrl);
  expect(shared.status).toBe(200);
  await expect(shared.text()).resolves.toContain("/demo");

  // (4) Tampered tokens fail closed.
  const tampered = new URL(shareUrl);
  tampered.searchParams.set("itx_share", `${Date.now() + 60_000}.forged-signature`);
  expect((await fetch(tampered)).status).toBe(401);

  // (5) public: true opens the cap to anyone, knowingly.
  await projectItx.provideCapability({
    meta: { http: { expose: true, public: true } },
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
                async fetch() {
                  return new Response("hello, public internet");
                }
              }
            `,
          },
        },
      },
    },
  });
  const publicResponse = await fetch(capUrl);
  expect(publicResponse.status).toBe(200);
  await expect(publicResponse.text()).resolves.toBe("hello, public internet");

  // (6) Unexposed caps do not exist as hostnames, even with admin auth.
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
  const internal = await fetch(internalUrl, {
    headers: { authorization: `Bearer ${adminApiSecret()}` },
  });
  expect(internal.status).toBe(404);
});

// ---- helpers ----------------------------------------------------------------

function suffix() {
  return crypto.randomUUID().slice(0, 8);
}
