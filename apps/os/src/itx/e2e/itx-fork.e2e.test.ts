// Child contexts (spec §3): itx.extend() creates a cheap, disposable context
// under a project — same anatomy, own capability table, parent chain for misses.
// This is the container an agent session or REPL scratchpad lives in.

import { expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import { connectItx } from "../client.ts";
import {
  adminApiSecret,
  baseUrl,
  connectGlobal,
  registerCreatedProjectCleanup,
} from "./e2e-env.ts";

const createdProjectIds = registerCreatedProjectCleanup();

test("extend: child caps shadow the parent, misses delegate up the chain", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `itx-fork-${suffix()}` })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  // A project-level cap every child should see through the chain.
  await projectItx.provideCapability({
    name: "shared",
    capability: chatPostTarget("project-level"),
  });

  // The node's own ADDRESS is a cap target (itx-next.md, address
  // unification): the save() half of the SturdyRef story.
  const address = (await (projectItx as never as Record<string, any>).project.address()) as {
    type: string;
    worker: { type: string; binding: string; name: string };
  };
  expect(address).toMatchObject({
    type: "rpc",
    worker: { type: "durable-object", binding: "PROJECT", name: expect.any(String) },
  });

  using child = await projectItx.extend({ name: "e2e-session" });
  const childDescription = await child.describe();
  expect(String(childDescription.context)).toMatch(/^ctx_/);
  expect(childDescription.project).toMatchObject({ id: project.id });

  // (1) Chain miss → parent's cap answers.
  const viaChain = (await (child as never as Record<string, any>).shared.chat.post({
    text: "hi",
  })) as { marker: string };
  expect(viaChain.marker).toBe("project-level");

  // (2) The child provides its own capability under the SAME name → shadows
  // visibly (describe reports the owner).
  await child.provideCapability({
    name: "shared",
    capability: chatPostTarget("child-level"),
  });
  const viaShadow = (await (child as never as Record<string, any>).shared.chat.post({
    text: "hi",
  })) as { marker: string };
  expect(viaShadow.marker).toBe("child-level");

  const merged = (await child.describe()).capabilities as Array<{ name: string; owner: string }>;
  const shared = merged.filter((entry) => entry.name === "shared");
  expect(shared).toHaveLength(1);
  expect(String(shared[0]!.owner)).toMatch(/^ctx_/);

  // (3) The parent is untouched — and a sibling extension sees the parent's cap.
  using sibling = await projectItx.extend();
  const viaSibling = (await (sibling as never as Record<string, any>).shared.chat.post({
    text: "hi",
  })) as { marker: string };
  expect(viaSibling.marker).toBe("project-level");

  // (4) A child context is itself connectable by id — same handle, fresh
  // session (this is how a second participant joins an agent session).
  using reconnected = connectItx({
    baseUrl: baseUrl(),
    context: String(childDescription.context),
    token: adminApiSecret(),
  });
  const reconnectedShadow = (await (reconnected as never as Record<string, any>).shared.chat.post({
    text: "hi again",
  })) as { marker: string };
  expect(reconnectedShadow.marker).toBe("child-level");
});

test("extend: a path provide shadows ONE subtree of an inherited capability (longest-prefix dispatch)", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `itx-fork-path-${suffix()}` })) as {
    id: string;
  };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  // A live SDK-shaped cap at the root name: ONE call({ path, args }) method
  // that reports where it ran and which dotted path arrived.
  class MarkedSdk extends RpcTarget {
    constructor(private readonly from: string) {
      super();
    }
    async call({ path }: { path: string[]; args: unknown[] }) {
      return { from: this.from, method: path.join(".") };
    }
  }
  await projectItx.provideCapability({
    name: "sdk",
    capability: new MarkedSdk("base") as never,
  });

  // The extension overrides exactly one method via a PATH provide; the entry path
  // is consumed by resolution, so the override target sees the remainder.
  using child = await projectItx.extend({ name: "e2e-path-shadow" });
  await child.provideCapability({
    path: ["sdk", "chat", "postMessage"],
    capability: new MarkedSdk("override") as never,
  });

  const handle = (target: unknown) => target as never as Record<string, any>;

  // (1) The shadowed subtree hits the override (remainder is empty: the
  // whole call path matched the entry path).
  expect(await handle(child).sdk.chat.postMessage({ text: "hi" })).toMatchObject({
    from: "override",
    method: "",
  });

  // (2) Every other sdk.* call misses the child's own table entirely and
  // falls through the chain to the base cap, remainder intact.
  expect(await handle(child).sdk.users.list()).toMatchObject({
    from: "base",
    method: "users.list",
  });
  // …including a SIBLING method under the shadowed prefix's parent.
  expect(await handle(child).sdk.chat.update({ ts: "1" })).toMatchObject({
    from: "base",
    method: "chat.update",
  });

  // (3) The parent handle is untouched.
  expect(await handle(projectItx).sdk.chat.postMessage({ text: "hi" })).toMatchObject({
    from: "base",
    method: "chat.postMessage",
  });

  // (4) Reserved segments are rejected per-segment at provide time.
  await expect(
    child.provideCapability({
      path: ["sdk", "constructor"],
      capability: new MarkedSdk("nope") as never,
    }),
  ).rejects.toThrow(/reserved/);
});

test("extend: workspaces are HOST-provided — plain extensions share the project workspace", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `itx-fork-ws-${suffix()}` })) as {
    id: string;
  };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  // Workspaces are not itx's concern (no per-context derivation magic): the
  // platform context provides the PROJECT workspace explicitly, so a plain
  // extension inherits that same workspace through the chain…
  using child = await projectItx.extend({ name: "e2e-ws" });
  const handle = (target: unknown) => target as never as Record<string, any>;

  const marker = suffix();
  await handle(child).workspace.writeFile(`/shared-${marker}.txt`, "written by the child");
  await expect(handle(projectItx).workspace.readFile(`/shared-${marker}.txt`)).resolves.toBe(
    "written by the child",
  );

  // …while a context whose HOST provides its own `workspace` capability —
  // the agent pattern: an explicit workspaceId bound to its own identity —
  // is isolated from the shared one.
  using isolated = await projectItx.extend({ name: "e2e-ws-isolated" });
  await isolated.provideCapability({
    capability: {
      entrypoint: "WorkspaceCapability",
      props: { workspaceId: `e2e-${marker}` },
      type: "rpc",
      worker: { type: "loopback" },
    },
    name: "workspace",
  });
  await expect(handle(isolated).workspace.readFile(`/shared-${marker}.txt`)).rejects.toThrow();
  await handle(isolated).workspace.writeFile(`/own-${marker}.txt`, "isolated");
  await expect(handle(isolated).workspace.readFile(`/own-${marker}.txt`)).resolves.toBe("isolated");
  await expect(handle(projectItx).workspace.readFile(`/own-${marker}.txt`)).rejects.toThrow();
});

test("extend narrows access: a session cannot reach sibling projects", async () => {
  using itx = connectGlobal();
  // Two projects under an admin (access "all") handle.
  const a = (await itx.projects.create({ slug: `itx-fork-a-${suffix()}` })) as { id: string };
  const b = (await itx.projects.create({ slug: `itx-fork-b-${suffix()}` })) as { id: string };
  createdProjectIds.push(a.id, b.id);

  using projectA = await itx.projects.get(a.id);
  using session = await projectA.extend({ name: "agent-session" });

  // The extended session is narrowed to project A — it must NOT be able to hop
  // to a sibling project even though it descends from an admin handle.
  await expect(session.projects.get(b.id)).rejects.toThrow(/not found/i);
  // ...but reaching its own project is fine.
  await expect(session.projects.get(a.id)).resolves.toBeDefined();
});

test("extend: child worker caps run with the owning project's authority", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `itx-fork-itx-${suffix()}` })) as {
    id: string;
  };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);
  using child = await projectItx.extend();

  // The child-scoped cap's own itx writes to the project's streams.
  await child.provideCapability({
    name: "noter",
    capability: {
      type: "rpc",
      worker: {
        type: "source",
        source: {
          cacheKey: crypto.randomUUID(),
          mainModule: "cap.js",
          modules: {
            "cap.js": `
              import { WorkerEntrypoint } from "cloudflare:workers";
              export default class extends WorkerEntrypoint {
                async note({ text }) {
                  const itx = await this.env.ITERATE.context;
                  const appended = await itx.streams.get("/itx-e2e/notes").append({
                    payload: { text },
                    type: "events.iterate.test/itx/note",
                  });
                  return { context: (await itx.describe()).context, offset: appended.offset };
                }
              }
            `,
          },
        },
      },
    },
  });

  const noted = (await (child as never as Record<string, any>).noter.note({
    text: "from a child context",
  })) as { context: string };
  expect(noted.context).toMatch(/^ctx_/);

  const events = (await projectItx.streams.get("/itx-e2e/notes").read()) as Array<{
    payload: { text?: string };
    type: string;
  }>;
  expect(
    events
      .filter((event) => event.type === "events.iterate.test/itx/note")
      .map((event) => event.payload.text),
  ).toEqual(["from a child context"]);
});

// ---- the two locked acceptance tests (itx-next.md, "Locked in review") -------

test(
  "extend: MIDDLEWARE — a bare-function fetch shadow intercepts both doors and delegates via itx.parent",
  { timeout: 120_000 },
  async () => {
    using itx = connectGlobal();
    const project = (await itx.projects.create({ slug: `itx-mw-${suffix()}` })) as { id: string };
    createdProjectIds.push(project.id);
    using projectItx = await itx.projects.get(project.id);
    using child = await projectItx.extend({ name: "middleware" });
    const childHandle = child as never as Record<string, any>;

    // A URL the REAL egress pipe can reach deterministically: this
    // deployment's own /api/itx answers 401 without credentials, so a 401
    // riding back through the shadow proves the delegated hop hit the
    // genuine default pipe.
    const probeUrl = new URL("/api/itx", baseUrl()).toString();

    // The shadow is a BARE FUNCTION — no RpcTarget, no asPathCallable. It
    // crosses the provide input nested inside a plain object, which is the
    // bare-nested-function-over-capnweb serialization proof: capnweb stubs
    // the function, the platform probes the stub (a pure property pull) and
    // auto-wraps it so call({ path: [], args: [request] }) invokes it.
    const seen: string[] = [];
    const provision = await child.provideCapability({
      capability: async (request: { url?: string }) => {
        const url = request?.url ?? String(request);
        seen.push(url);
        // Middleware: delegate to the UNSHADOWED pipe — itx.parent is the
        // "call next()" of the chain (the parent context has no shadow, so
        // its `fetch` resolves the platform default).
        const delegated = (await childHandle.parent.fetch(url)) as Response;
        return new Response(JSON.stringify({ delegatedStatus: delegated.status, shadowed: true }), {
          headers: { "content-type": "application/json" },
        });
      },
      name: "fetch",
    });

    // (1) The EXPLICIT door: itx.fetch on the extension lands on the shadow,
    // which delegates through the parent to the real pipe (401 from /api/itx).
    const explicit = await child.fetch(probeUrl);
    expect(await explicit.json()).toEqual({ delegatedStatus: 401, shadowed: true });

    // (2) The IMPLICIT door: bare fetch() inside a script run ON THIS
    // CONTEXT (globalOutbound = ProjectEgress, dispatching at the
    // originating context) resolves the same shadow through the chain.
    const childContext = String((await child.describe()).context);
    const bareFetchScript = async ({ vars }: { vars: { url: string } }) => {
      const response = await fetch(vars.url);
      return await response.json();
    };
    const scriptResponse = await fetch(new URL("/api/itx/run", baseUrl()), {
      body: JSON.stringify({
        context: childContext,
        functionSource: bareFetchScript.toString(),
        vars: { url: probeUrl },
      }),
      headers: {
        authorization: `Bearer ${adminApiSecret()}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const scriptBody = (await scriptResponse.json()) as { error?: string; result?: unknown };
    if (!scriptResponse.ok) throw new Error(`bare-fetch script failed: ${scriptBody.error}`);
    expect(scriptBody.result).toEqual({ delegatedStatus: 401, shadowed: true });
    expect(seen).toEqual([probeUrl, probeUrl]);

    // (3) The parent/project is unaffected: its fetch is the raw pipe.
    const parentResponse = await projectItx.fetch(probeUrl);
    expect(parentResponse.status).toBe(401);
    expect(seen).toHaveLength(2);

    // (4) Revoke through the provision handle: the default pipe resurfaces
    // on the extension — a raw 401, no shadow JSON.
    await provision.revoke();
    const restored = await child.fetch(probeUrl);
    expect(restored.status).toBe(401);
    expect(seen).toHaveLength(2);
  },
);

test(
  "extend: INDIRECTION — an inherited source cap's bare fetch() dials back through the invoking extension's shadow",
  { timeout: 120_000 },
  async () => {
    using itx = connectGlobal();
    const project = (await itx.projects.create({ slug: `itx-ind-${suffix()}` })) as { id: string };
    createdProjectIds.push(project.id);
    using projectItx = await itx.projects.get(project.id);

    // The capability is defined on the PROJECT; its worker code does a bare
    // fetch() — Law 5 wiring routes that through the egress pipe of the
    // context the call ORIGINATED at, not the context the definition lives on.
    await projectItx.provideCapability({
      capability: {
        type: "rpc",
        worker: {
          type: "source",
          source: {
            cacheKey: crypto.randomUUID(),
            mainModule: "cap.js",
            modules: {
              "cap.js": `
                import { WorkerEntrypoint } from "cloudflare:workers";
                export default class extends WorkerEntrypoint {
                  async probe({ url }) {
                    const response = await fetch(url);
                    return await response.json();
                  }
                }
              `,
            },
          },
        },
      },
      name: "prober",
    });

    using shadowed = await projectItx.extend({ name: "shadowed" });
    using sibling = await projectItx.extend({ name: "sibling" });
    const handle = (target: unknown) => target as never as Record<string, any>;

    const seen: string[] = [];
    await shadowed.provideCapability({
      capability: async (request: { url?: string }) => {
        seen.push(request?.url ?? String(request));
        return new Response(JSON.stringify({ via: "shadow" }), {
          headers: { "content-type": "application/json" },
        });
      },
      name: "fetch",
    });

    // Invoked THROUGH the shadowing extension: prober misses on the
    // extension, delegates up with origin = the extension, the project dials
    // the source isolate scoped to that ORIGIN — so its bare fetch() climbs
    // the extension's chain and lands on the shadow. The .invalid TLD
    // guarantees NXDOMAIN, so a JSON answer can only be the shadow's.
    const url = "https://indirection-probe.invalid/x";
    await expect(handle(shadowed).prober.probe({ url })).resolves.toEqual({ via: "shadow" });
    expect(seen).toEqual([url]);

    // A sibling extension and the project itself resolve the real pipe — the
    // NXDOMAIN host fails for them and the shadow never sees their requests.
    await expect(handle(sibling).prober.probe({ url })).rejects.toThrow();
    await expect(handle(projectItx).prober.probe({ url })).rejects.toThrow();
    expect(seen).toEqual([url]);
  },
);

// ---- helpers ----------------------------------------------------------------

function chatPostTarget(marker: string) {
  // Source caps are member-shaped: the dial wraps the loader entrypoint
  // and replays the dotted path on its real members (nested RpcTargets too).
  return {
    type: "rpc" as const,
    worker: {
      type: "source" as const,
      source: {
        cacheKey: crypto.randomUUID(),
        mainModule: "cap.js",
        modules: {
          "cap.js": `
            import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
            class Chat extends RpcTarget {
              post(...args) {
                return { args, marker: ${JSON.stringify(marker)}, method: "chat.post" };
              }
            }
            export default class extends WorkerEntrypoint {
              get chat() { return new Chat(); }
            }
          `,
        },
      },
    },
  };
}

function suffix() {
  return crypto.randomUUID().slice(0, 8);
}
