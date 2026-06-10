// Child contexts (spec §3): itx.fork() creates a cheap, disposable context
// under a project — same anatomy, own registry, parent chain for misses.
// This is the container an agent session or REPL scratchpad lives in.

import { expect, test } from "vitest";
import { connectItx } from "../client.ts";
import {
  adminApiSecret,
  baseUrl,
  connectGlobal,
  registerCreatedProjectCleanup,
} from "./e2e-env.ts";

const createdProjectIds = registerCreatedProjectCleanup();

test("fork: child caps shadow the parent, misses delegate up the chain", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `itx-fork-${suffix()}` })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  // A project-level cap every child should see through the chain.
  await projectItx.caps.define({
    invoke: "path-call",
    name: "shared",
    source: pathCallSource("project-level"),
  });

  using child = await projectItx.fork({ name: "e2e-session" });
  const childDescription = await child.describe();
  expect(String(childDescription.context)).toMatch(/^ctx_/);
  expect(childDescription.project).toMatchObject({ id: project.id });

  // (1) Chain miss → parent's cap answers.
  const viaChain = (await (child as never as Record<string, any>).shared.chat.post({
    text: "hi",
  })) as { marker: string };
  expect(viaChain.marker).toBe("project-level");

  // (2) Child defines its own cap under the SAME name → shadows the parent,
  // visibly (describe reports the owner).
  await child.caps.define({
    invoke: "path-call",
    name: "shared",
    source: pathCallSource("child-level"),
  });
  const viaShadow = (await (child as never as Record<string, any>).shared.chat.post({
    text: "hi",
  })) as { marker: string };
  expect(viaShadow.marker).toBe("child-level");

  const merged = (await child.caps.describe()) as Array<{ name: string; owner: string }>;
  const shared = merged.filter((cap) => cap.name === "shared");
  expect(shared).toHaveLength(1);
  expect(String(shared[0]!.owner)).toMatch(/^ctx_/);

  // (3) The parent is untouched — and a sibling fork sees the parent's cap.
  using sibling = await projectItx.fork();
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

test("fork narrows access: a session cannot reach sibling projects", async () => {
  using itx = connectGlobal();
  // Two projects under an admin (access "all") handle.
  const a = (await itx.projects.create({ slug: `itx-fork-a-${suffix()}` })) as { id: string };
  const b = (await itx.projects.create({ slug: `itx-fork-b-${suffix()}` })) as { id: string };
  createdProjectIds.push(a.id, b.id);

  using projectA = await itx.projects.get(a.id);
  using session = await projectA.fork({ name: "agent-session" });

  // The forked session is narrowed to project A — it must NOT be able to hop
  // to a sibling project even though it descends from an admin handle.
  await expect(session.projects.get(b.id)).rejects.toThrow(/not found/i);
  // ...but reaching its own project is fine.
  await expect(session.projects.get(a.id)).resolves.toBeDefined();
});

test("fork: child worker caps run with the owning project's authority", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `itx-fork-itx-${suffix()}` })) as {
    id: string;
  };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);
  using child = await projectItx.fork();

  // The child-scoped cap's own itx writes to the project's streams.
  await child.caps.define({
    name: "noter",
    source: {
      codeId: crypto.randomUUID(),
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

// ---- helpers ----------------------------------------------------------------

function pathCallSource(marker: string) {
  return {
    codeId: crypto.randomUUID(),
    mainModule: "cap.js",
    modules: {
      "cap.js": `
        import { WorkerEntrypoint } from "cloudflare:workers";
        export default class extends WorkerEntrypoint {
          async call({ path, args }) {
            return { args, marker: ${JSON.stringify(marker)}, method: path.join(".") };
          }
        }
      `,
    },
  };
}

function suffix() {
  return crypto.randomUUID().slice(0, 8);
}
