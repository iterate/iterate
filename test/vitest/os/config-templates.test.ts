// config-templates.test.ts — the project templates: core's (core/configs/*, which every build
// offers) and iterate's (configs/*, the platform's build input via scripts/os/config-templates.ts).
// Each names its main module, and each one's `processEvent` installs what it promises, in Node.
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { codedError } from "iterate/lib";
import { expect, test, vi } from "vitest";
import { reduceProcessor } from "iterate/stream/test-support";
import type { StreamEvent } from "iterate/stream/processor";
import DefaultTemplate from "../../../core/configs/default/worker.ts";
import VoiceTemplate from "../../../configs/voice/worker.ts";
import { EmailProcessor } from "../../../core/os/src/email/processor.ts";

test("every template's package.json names its folder's main module", () => {
  const repo = path.resolve(import.meta.dirname, "../../..");
  const manifests = globSync("{core/configs,configs}/*/**/package.json", {
    cwd: repo,
    exclude: (file) => file.includes("node_modules"),
  });
  expect(manifests).toEqual(
    expect.arrayContaining([
      "core/configs/default/package.json",
      "core/configs/minimal/package.json",
      "configs/voice/package.json",
    ]),
  );
  for (const manifest of manifests) {
    const { main } = JSON.parse(readFileSync(path.join(repo, manifest), "utf8")) as {
      main?: string;
    };
    expect(main, manifest).toBeTruthy();
    expect(existsSync(path.join(repo, path.dirname(manifest), main!)), manifest).toBe(true);
  }
});

const agentsRule = { "itx.agents": expect.objectContaining({ match: "itx.agents" }) };

test.for([
  { template: "default", Template: DefaultTemplate, rules: agentsRule, schedules: {} },
  {
    template: "voice",
    Template: VoiceTemplate,
    rules: {
      ...agentsRule,
      "itx.voice": expect.objectContaining({
        target: ["itx", "workers", ["get", expect.objectContaining({ mainModule: "voice.ts" })]],
      }),
    },
    schedules: {},
  },
])(
  "$template: the platform's project/worker-updated installs the template's apps and schedules",
  async ({ Template, rules: expectedRules, schedules }) => {
    const project = fakeProject(Template);
    await project.deliver({
      type: "events.iterate.com/project/worker-updated",
      path: "/",
      source: { origin: "/", platform: true as const },
    });
    const { rules, rows } = project;
    expect({ rules, rows, schedules: project.schedules }).toEqual({
      rules: expectedRules,
      rows: { agents: expect.objectContaining({ className: "AgentCollectionDurableObject" }) },
      schedules,
    });
  },
);

test.for([
  { name: "a stranger's mail", sender: false },
  {
    name: "a member's mail that did not come straight from their domain (a replay or a forward)",
    sender: true,
    direct: false,
  },
  { name: "automated mail", sender: true, automated: true },
])("$name reaches no agent", async ({ sender, direct, automated }) => {
  const project = fakeProject();
  const email = project.receiveEmail({ messageId: "a@x", member: sender, direct, automated });
  await project.deliver(email);
  const { agents, appended } = project;
  expect({ agents, appended }).toEqual({ agents: [], appended: {} });
});

test("a member's email waits until the email facet has folded it, then goes to its thread's agent, once", async () => {
  const project = fakeProject();
  const first = project.receiveEmail({ messageId: "a@x", subject: "Hi", text: "Hello" });
  const delivered = project.deliver(first);
  await new Promise((resolve) => setTimeout(resolve, 10)); // long enough for a delivery not to wait
  expect(project).toMatchObject({ agents: [] });
  project.emailFacetFolds(first.offset);
  await delivered;
  // their reply joins the thread, delivered twice
  const reply = project.receiveEmail({ messageId: "b@x", inReplyTo: "a@x" });
  project.emailFacetFolds(reply.offset);
  for (const email of [reply, reply]) await project.deliver(email);
  expect(project).toMatchObject({ agents: ["/agents/email/t1"] });
  expect(project.appended["/agents/email/t1"]).toEqual([
    expect.objectContaining({
      type: "events.iterate.com/agent/context-added",
      idempotencyKey: "email:1",
      payload: expect.objectContaining({
        role: "user",
        content: expect.stringMatching(
          /Email from ann@x: Hi[\s\S]*Hello[\s\S]*itx\.email\.send\(\{ inReplyToOffset: 1, text \}\)/,
        ),
      }),
    }),
    expect.objectContaining({ idempotencyKey: "email:2" }),
  ]);
});

test("an email an agent already has under its key, from an earlier version of this code, is delivered once", async () => {
  const project = fakeProject();
  const email = project.receiveEmail({ messageId: "a@x" });
  project.emailFacetFolds(email.offset);
  project.appended["/agents/email/t1"] = [
    { type: "events.iterate.com/agent/context-added", idempotencyKey: "email:1", payload: {} },
  ];
  await project.deliver(email);
  expect(project.appended["/agents/email/t1"]).toHaveLength(1);
});

/** An in-memory project a template's `processEvent` runs against, its appends keyed as the platform's. */
function fakeProject(Template: typeof DefaultTemplate = DefaultTemplate) {
  const rules: Record<string, unknown> = {};
  const rows: Record<string, unknown> = {};
  const schedules: Record<string, { when: unknown; events: unknown; scheduledAtOffset: number }> =
    {};
  const agents: string[] = [];
  const appended: Record<string, { type: string; idempotencyKey?: string; payload?: unknown }[]> =
    {};
  const mail: StreamEvent[] = [];
  let foldedThrough = 0;
  let rootOffset = 0;
  const folded = vi.fn<() => void>();
  const emailFacet = {
    waitUntilProcessed: ({ offset }: { offset: number }) =>
      new Promise<void>((resolve) => {
        const check = () => (foldedThrough >= offset ? resolve() : undefined);
        folded.mockImplementation(check);
        check();
      }),
    snapshot: async () => ({
      offset: foldedThrough,
      state: reduceProcessor(new EmailProcessor(), mail.slice(0, foldedThrough)),
    }),
  };
  const itx = {
    kv: { put: async () => ({ ok: true }) },
    processors: {
      enable: async (name: string, spec: unknown) => {
        rows[name] = spec;
        return { name };
      },
    },
    append: async (...events: { type: string; payload?: { match?: string } }[]) => {
      for (const event of events)
        if (event.type === "events.iterate.com/itx/rewrite-rule-configured")
          rules[event.payload!.match!] = event.payload;
      return [];
    },
    schedules: {
      set: async ({ key, when, events }: { key: string; when: unknown; events: unknown }) => {
        schedules[key] = { when, events, scheduledAtOffset: ++rootOffset };
        return { key, scheduledAtOffset: rootOffset };
      },
    },
    agents: {
      create: async (path: string) => {
        if (!agents.includes(path)) agents.push(path);
        return { path };
      },
    },
    cd: (path: string) => ({
      facets: { get: () => emailFacet },
      append: async (event: { type: string; idempotencyKey?: string; payload?: unknown }) => {
        const log = (appended[path] ??= []);
        const existing = log.find((logged) => logged.idempotencyKey === event.idempotencyKey);
        if (!existing) log.push(event);
        else if (JSON.stringify(existing.payload) !== JSON.stringify(event.payload))
          throw codedError("IDEMPOTENCY_CONFLICT", `idempotency key "${event.idempotencyKey}"`);
        return [];
      },
    }),
  };
  const template = new Template({} as never, {} as never);
  return {
    rules,
    rows,
    schedules,
    agents,
    appended,
    /** One delivery of `event`, as the platform makes it. */
    deliver: (event: Partial<StreamEvent> & { type: string }) =>
      template.processEvent({
        event: {
          offset: 1,
          createdAt: "2026-09-28T00:00:00.000Z",
          path: "/",
          source: { origin: "/" },
          ...event,
        },
        itx: itx as never,
      }),
    /** An `email/received` the platform records on `/integrations/email`, at the next offset. */
    receiveEmail(input: {
      messageId: string | null;
      inReplyTo?: string;
      subject?: string;
      text?: string;
      member?: boolean;
      direct?: boolean;
      automated?: boolean;
    }) {
      const event: StreamEvent = {
        type: "events.iterate.com/email/received",
        offset: mail.length + 1,
        createdAt: "2026-09-28T00:00:00.000Z",
        path: "/integrations/email",
        source: { origin: "/integrations/email", platform: true },
        payload: {
          messageId: input.messageId,
          from: "ann@x",
          to: ["acme@iterate.app"],
          cc: [],
          subject: input.subject || "Re: Hi",
          text: input.text || "More",
          html: null,
          inReplyTo: input.inReplyTo || null,
          references: input.inReplyTo ? [input.inReplyTo] : [],
          attachments: [],
          envelope: { from: "ann@x", to: "acme@iterate.app" },
          sender: {
            verified: true,
            member: input.member ?? true,
            direct: input.direct ?? true,
          },
          automated: input.automated ?? false,
          authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
        },
      };
      mail.push(event);
      return event;
    },
    /** The `email` facet has folded the mail through `offset`. */
    emailFacetFolds(offset: number) {
      foldedThrough = offset;
      folded();
    },
  };
}
