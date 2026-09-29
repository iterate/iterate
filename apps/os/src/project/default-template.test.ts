// src/project/default-template.test.ts — configs/default/worker.ts's `processEvent`, run in Node
// against an in-memory project: the init case and the email case, each safe to deliver again. Both
// trust the event's type alone: only the platform appends either (caller.ts `PLATFORM_FACT_TYPES`,
// __workers-tests__/platform-facts.test.ts). configs/heartbeat/worker.ts's init case beside it: the
// same, and the heartbeat.
import { codedError } from "iterate/lib";
import { expect, test, vi } from "vitest";
import { reduceProcessor } from "iterate/stream/test-support";
import type { StreamEvent } from "iterate/stream/processor";
import DefaultTemplate from "../../../../configs/default/worker.ts";
import HeartbeatTemplate from "../../../../configs/heartbeat/worker.ts";
import { EmailProcessor } from "../email/processor.ts";

test.for([
  { template: "default", Template: DefaultTemplate, schedules: {} },
  {
    template: "heartbeat",
    Template: HeartbeatTemplate,
    schedules: {
      heartbeat: {
        when: { everyMs: 300_000 },
        events: [{ type: "heartbeat" }],
        scheduledAtOffset: 1,
      },
    },
  },
])(
  "$template: the platform's project/worker-updated installs agents, voice and the template's schedules, and running it again changes nothing",
  async ({ Template, schedules }) => {
    const project = fakeProject(Template);
    const published = {
      type: "events.iterate.com/project/worker-updated",
      path: "/",
      source: { origin: "/", platform: true as const },
    };
    const installed = () => {
      const { rules, rows, schedules, kv } = project;
      return structuredClone({ rules, rows, schedules, kv: Object.keys(kv) });
    };
    await project.deliver(published);
    const first = installed();
    expect(first).toEqual({
      rules: {
        "itx.agents": expect.objectContaining({ match: "itx.agents" }),
        "itx.voice": expect.objectContaining({
          target: ["itx", "workers", ["get", expect.objectContaining({ mainModule: "voice.ts" })]],
        }),
      },
      rows: { agents: expect.objectContaining({ className: "AgentCollectionDurableObject" }) },
      schedules,
      kv: ["voice/screen-font.css"],
    });
    // a heartbeat is set again as it stands, so it keeps its clock
    await project.deliver(published);
    expect(installed()).toEqual(first);
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
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(project).toMatchObject({ agents: [] });
  project.emailFacetFolds(first.offset);
  await delivered;
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
  ]);

  // their reply joins the thread; a message with neither Message-ID nor a known parent starts one;
  // one with no Message-ID that answers a known message joins that message's thread
  const reply = project.receiveEmail({ messageId: "b@x", inReplyTo: "a@x" });
  const unthreaded = project.receiveEmail({ messageId: null });
  const answerWithoutId = project.receiveEmail({ messageId: null, inReplyTo: "b@x" });
  project.emailFacetFolds(answerWithoutId.offset);
  for (const email of [reply, unthreaded, answerWithoutId, reply]) await project.deliver(email);
  expect(project).toMatchObject({ agents: ["/agents/email/t1", "/agents/email/t3"] });
  expect(project.appended["/agents/email/t1"]!.map((event) => event.idempotencyKey)).toEqual([
    "email:1",
    "email:2",
    "email:4",
  ]);
  expect(project.appended["/agents/email/t3"]!.map((event) => event.idempotencyKey)).toEqual([
    "email:3",
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

/** An in-memory project the template's `processEvent` runs against: the root's rewrite rules,
 *  processor rows and schedules; `/integrations/email`'s mail and its `email` facet, which folds
 *  only through the offset `emailFacetFolds` last released; the agents `itx.agents.create` made;
 *  and every append on an agent's context, deduplicated by idempotency key as the platform does. */
function fakeProject(Template: typeof DefaultTemplate = DefaultTemplate) {
  const rules: Record<string, unknown> = {};
  const rows: Record<string, unknown> = {};
  const kv: Record<string, string> = {};
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
    kv: {
      put: async (key: string, value: string) => {
        kv[key] = value;
        return { ok: true };
      },
    },
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
      get: (key: string) => schedules[key] ?? null,
      // as the platform's: an interval set again as it stands keeps its clock (built-ins.ts)
      set: async (input: { key: string; when: unknown; events: unknown }) => {
        const live = schedules[input.key];
        if (
          JSON.stringify(live && [live.when, live.events]) !==
          JSON.stringify([input.when, input.events])
        )
          schedules[input.key] = {
            when: input.when,
            events: input.events,
            scheduledAtOffset: ++rootOffset,
          };
        return { key: input.key, scheduledAtOffset: schedules[input.key]!.scheduledAtOffset };
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
    kv,
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
