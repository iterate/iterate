import { expect, test } from "vitest";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import type { Agent } from "../../src/itx-api.generated.ts";
import { itxScript } from "../test-support/itx-script-builder.ts";
import { AGENT_CONTEXT_ADDED_TYPE, AGENT_WEB_MESSAGE_SENT_TYPE } from "./itx-test-support.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// A restricted itx surface (domains/itx/surface.ts) end to end: an agent born
// with a surfaced capability host, and a scoped itx handed out by
// project.scope(). Both are the platform's answer to "an agent (or a
// visitor) that must not hold the project's authority".

test("an agent born with a surface: scripts see only the listed built-ins", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(uniqueFixtureSlug("restricted-agent")).create({});
  await project.__describe();
  const agentPath = `/agents/restricted-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);
  const surface = ["chat.sendMessage", "docs"];
  await agent.create(undefined, { capabilityHost: { config: { surface }, fallback: null } });

  // The certificate landed as asked — and is fixed: a different one is
  // rejected by the same-key-different-body rule the birth batch relies on.
  const [hostBirth] = await agent.stream.getEvents({
    eventTypes: ["events.iterate.com/capability-host/created"],
  });
  expect(hostBirth?.payload).toEqual({ config: { surface }, fallback: null });
  await expect(
    (async () => {
      await agent.create(undefined, { capabilityHost: { config: {}, fallback: null } });
    })(),
  ).rejects.toThrow();

  // Inside the scope: the description is the restricted one, chat works,
  // and a removed built-in is an unknown name at runtime — even when the
  // script hides the access from the typecheck gate behind a cast.
  const inside = await itxScript(agent.capabilityHost).execute(async (itx) => {
    const description = await itx.__describe();
    // Computed keys keep these accesses out of the typecheck gate (the gate
    // is proven separately below); this is the RUNTIME wall.
    const errors: Record<string, string> = {};
    for (const [name, attempt] of [
      ["repo", () => Reflect.get(itx, "re" + "po").readFile({ path: "AGENTS.md" })],
      ["agents", () => Reflect.get(itx, "age" + "nts").list()],
    ] as const) {
      try {
        await attempt();
        errors[name] = "no error";
      } catch (error) {
        errors[name] = error instanceof Error ? error.message : String(error);
      }
    }
    if (itx.chat === undefined) throw new Error("expected an agent-scoped itx");
    await itx.chat.sendMessage("hello from a restricted scope");
    return {
      children: Object.keys(description.children).sort(),
      errors,
      instructions: description.instructions,
    };
  });
  const seen = inside.success();
  expect(seen).toMatchObject({ children: ["chat", "docs"] });
  expect(seen.instructions).toContain("RESTRICTED scope");
  expect(seen.errors.repo).toMatch(/no capability "repo\.readFile"/);
  expect(seen.errors.agents).toMatch(/no capability "agents\.list"/);
  const [sent] = await agent.stream.getEvents({ eventTypes: [AGENT_WEB_MESSAGE_SENT_TYPE] });
  expect(sent?.payload).toMatchObject({ message: "hello from a restricted scope" });

  // The typecheck gate is the first wall: reaching for a removed built-in
  // does not even run.
  await expect(
    itxScript(agent.capabilityHost).executeSource(
      'async (itx) => itx.repo.readFile({ path: "AGENTS.md" })',
    ),
  ).rejects.toThrow(/ItxMemberRemovedFromThisScope/);
});

test("project.scope() hands out a narrowed, project-confined itx for a path", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(uniqueFixtureSlug("scoped-itx")).create({});
  await project.__describe();
  const agentPath = `/agents/visitor-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);
  await agent.create();

  using scoped = project.scope({
    path: agentPath,
    surface: ["agent.message", "agent.liveState", "agent.stream.getEvents"],
  });
  const description = await scoped.__describe();
  expect(Object.keys(description.children)).toEqual(["agent"]);
  expect(description.instructions).toContain("RESTRICTED scope");

  // What the surface lists works; message() speaks as the scope's own
  // principal, not as the agent.
  // The stub's optional-getter typing loses the Agent shape; the wire value is the handle.
  const visitor = (scoped as unknown as { agent: Agent }).agent;
  await visitor.message("hi from a visitor");
  const added = (await visitor.stream.getEvents({ eventTypes: [AGENT_CONTEXT_ADDED_TYPE] })).find(
    (event) => (event.payload as { content?: string }).content === "hi from a visitor",
  );
  expect(added?.payload).toMatchObject({
    role: "user",
    content: "hi from a visitor",
    actor: { type: "user", origin: "web", userId: `scope:${agentPath}` },
  });

  // What it does not list is an unknown name: on the itx, on the agent
  // handle, and on the agent's stream.
  const hidden = scoped as unknown as {
    repo: { readFile(input: { path: string }): Promise<unknown> };
    agent: {
      kill(): Promise<void>;
      stream: { append(event: { type: string; payload: unknown }): Promise<unknown> };
    };
  };
  await expect(hidden.repo.readFile({ path: "AGENTS.md" })).rejects.toThrow(
    /no capability "repo\.readFile"/,
  );
  await expect(hidden.agent.kill()).rejects.toThrow(/no capability "kill"/);
  await expect(
    hidden.agent.stream.append({ type: "events.iterate.com/agent/paused", payload: {} }),
  ).rejects.toThrow(/"append" is not available in this scope/);
});
