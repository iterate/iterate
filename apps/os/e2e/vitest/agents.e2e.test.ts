/**
 * Deployment-targeted tests for OS project agents.
 *
 * These run through public oRPC/OpenAPI routes against a live OS deployment:
 *
 *   doppler run --project os --config preview_2 -- \
 *   pnpm --dir apps/os e2e -t "agent"
 */
import { expect, test } from "vitest";
import type { Event } from "@iterate-com/shared/streams/types";
import { durableObjectProcessorSubscriber } from "@iterate-com/streams/shared/callable-subscriber";
import dedent from "dedent";
import { createTestProjectFixture } from "../test-support/create-test-project.ts";
import type { OsClient } from "../test-support/os-client.ts";
import { DEFAULT_WORKERS_AI_AGENT_MODEL } from "~/domains/agents/stream-processors/agent/contract.ts";
import { getSlackIntegrationDurableObjectName } from "~/domains/slack/slack-naming.ts";

const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

type SlackChannel = {
  id: string;
  is_member?: boolean;
  name: string;
};

type SlackConversationsListResponse =
  | {
      channels: SlackChannel[];
      ok: true;
      response_metadata?: { next_cursor?: string };
    }
  | {
      error?: string;
      ok: false;
    };

const itIfSlackBotToken = process.env.APP_CONFIG_SLACK_BOT_TOKEN?.trim() ? test : test.skip;

test("can configure Cloudflare AI Gateway as the provider for an agent path prefix", async () => {
  await using fixture = await createTestProjectFixture({ slugPrefix: "agent-cloudflare-preset" });
  const { client, project } = fixture;
  const suffix = uniqueSuffix();
  const basePath = `/agents/cloudflare-preset-${suffix}`;
  const agentPath = `${basePath}/child`;
  const assistantMessage = `cloudflare ai gateway chat proof ${suffix}`;

  await client.project.agents.configurePreset({
    basePath,
    events: [],
    model: DEFAULT_WORKERS_AI_AGENT_MODEL,
    projectSlugOrId: project.id,
    provider: "cloudflare-ai",
    runOpts: { gateway: { id: "default" } },
    systemPrompt: [
      "For every user message, reply with exactly one fenced JavaScript code block and no surrounding prose.",
      "The block must evaluate to an async function.",
      "Use this exact code body:",
      dedent`
        async (itx) => {
          await itx.chat.sendMessage({ message: ${JSON.stringify(assistantMessage)} });
        }
      `,
    ].join("\n"),
  });

  const presets = await client.project.agents.listPresets({
    projectSlugOrId: project.id,
  });
  expect(presets.presets).toContainEqual(
    expect.objectContaining({
      basePath,
    }),
  );

  await client.project.agents.runtimeState({
    agentPath,
    projectSlugOrId: project.id,
  });
  await client.project.agents.sendMessage({
    agentPath,
    message: `cloudflare provider preset proof ${suffix}`,
    projectSlugOrId: project.id,
  });

  const events = await readUntil({
    agentPath,
    client,
    projectId: project.id,
    afterOffset: "start",
    predicate: (event) =>
      event.type === "events.iterate.com/agents/web-message-sent" &&
      (event.payload as { message?: unknown }).message === assistantMessage,
  });

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/os-agent/llm-provider-selected",
      payload: { provider: "cloudflare-ai" },
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/cloudflare-ai/llm-request-started",
      payload: expect.objectContaining({
        model: DEFAULT_WORKERS_AI_AGENT_MODEL,
      }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/cloudflare-ai/llm-request-completed",
      payload: expect.objectContaining({
        result: expect.objectContaining({
          status: "success",
        }),
      }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/agent/output-added",
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/itx/script-execution-requested",
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/agents/web-message-sent",
      payload: expect.objectContaining({
        message: assistantMessage,
      }),
    }),
  );
  expect(
    events.some((event) => event.type === "events.iterate.com/openai-ws/llm-request-started"),
  ).toBe(false);
  expect(events.filter((event) => event.type === "events.iterate.com/core/error-occurred")).toEqual(
    [],
  );
});

test("a web agent holds a real conversation: user message in, visible reply out", async () => {
  // THE end-to-end conversation proof (no canned system prompt, default
  // provider): a user message on a fresh agent stream must come back as a
  // visible web reply — the LLM turn runs, codemode executes, and
  // itx.chat.sendMessage lands web-message-sent on the stream.
  await using fixture = await createTestProjectFixture({ slugPrefix: "agent-web-convo" });
  const { client, project } = fixture;
  const suffix = uniqueSuffix();
  const agentPath = `/agents/web-convo-${suffix}`;
  const marker = `pong-${suffix}`;

  await client.project.agents.runtimeState({
    agentPath,
    projectSlugOrId: project.id,
  });
  await client.project.agents.sendMessage({
    agentPath,
    message: `Please reply in this chat with a short message that contains exactly this token: ${marker}`,
    projectSlugOrId: project.id,
  });

  const events = await readUntil({
    agentPath,
    client,
    projectId: project.id,
    afterOffset: "start",
    predicate: (event) =>
      event.type === "events.iterate.com/agents/web-message-sent" &&
      typeof (event.payload as { message?: unknown }).message === "string" &&
      (event.payload as { message: string }).message.includes(marker),
    timeoutMs: 150_000,
  });

  // The full round trip is on the stream: the user's message…
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/agents/user-message-received",
      payload: expect.objectContaining({
        content: expect.stringContaining(marker),
        origin: "web",
      }),
    }),
  );
  // …the agent's visible web reply…
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/agents/web-message-sent",
      payload: expect.objectContaining({
        message: expect.stringContaining(marker),
      }),
    }),
  );
  // …its chat tool arriving as a PROVIDED capability (the one door)…
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/itx/capability-provided",
      payload: expect.objectContaining({ path: ["chat"] }),
    }),
  );
  // …and no turn ended in an error.
  expect(events.filter((event) => event.type.endsWith("error-occurred"))).toEqual([]);
}, 180_000);

test("uses OpenAI for unconfigured agent chats by default", async () => {
  await using fixture = await createTestProjectFixture({ slugPrefix: "agent-default-openai" });
  const { client, project } = fixture;
  const suffix = uniqueSuffix();
  const agentPath = `/agents/default-openai-${suffix}`;

  await client.project.agents.runtimeState({
    agentPath,
    projectSlugOrId: project.id,
  });
  await client.project.agents.sendMessage({
    agentPath,
    message: `default OpenAI proof ${suffix}`,
    projectSlugOrId: project.id,
  });

  const events = await readUntil({
    agentPath,
    client,
    projectId: project.id,
    afterOffset: "start",
    predicate: (event) =>
      event.type === "events.iterate.com/openai-ws/llm-request-completed" &&
      (event.payload as { result?: { status?: unknown } }).result?.status === "success",
  });

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/os-agent/llm-provider-selected",
      payload: { provider: "openai-ws" },
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/openai-ws/config-updated",
      payload: expect.objectContaining({
        model: "gpt-5.5",
      }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/openai-ws/llm-request-started",
      payload: expect.objectContaining({
        model: "gpt-5.5",
      }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/agent/output-added",
    }),
  );
  expect(
    events.some((event) => event.type === "events.iterate.com/cloudflare-ai/llm-request-started"),
  ).toBe(false);
  expect(events.filter((event) => event.type === "events.iterate.com/core/error-occurred")).toEqual(
    [],
  );
});

test("recovers and still replies when the agent host durable object is killed mid-turn", async () => {
  await using fixture = await createTestProjectFixture({ slugPrefix: "agent-crash-recovery" });
  const { client, project } = fixture;
  const suffix = uniqueSuffix();
  const basePath = `/agents/crash-recovery-${suffix}`;
  const agentPath = `${basePath}/child`;
  const assistantMessage = `crash recovery proof ${suffix}`;

  await client.project.agents.configurePreset({
    basePath,
    events: [],
    model: DEFAULT_WORKERS_AI_AGENT_MODEL,
    projectSlugOrId: project.id,
    provider: "cloudflare-ai",
    systemPrompt: [
      "For every user message, reply with exactly one fenced JavaScript code block and no surrounding prose.",
      "The block must evaluate to an async function.",
      "Use this exact code body:",
      dedent`
        async (itx) => {
          await itx.chat.sendMessage({ message: ${JSON.stringify(assistantMessage)} });
        }
      `,
    ].join("\n"),
  });
  await client.project.agents.runtimeState({ agentPath, projectSlugOrId: project.id });

  // Round 1 — kill inside the debounce window. The llm-request-scheduled fact
  // is durable but its debounce timer lives only in the incarnation that just
  // died; the redial's subscriber-connected fact must drive the fresh
  // instance's scheduler reconciliation, or the agent wedges forever.
  await client.project.agents.sendMessage({
    agentPath,
    message: `crash during debounce ${suffix}`,
    projectSlugOrId: project.id,
  });
  await client.project.agents.kill({ agentPath, projectSlugOrId: project.id });

  const roundOneEvents = await readUntil({
    agentPath,
    client,
    projectId: project.id,
    afterOffset: "start",
    predicate: (event) =>
      event.type === "events.iterate.com/agents/web-message-sent" &&
      (event.payload as { message?: unknown }).message === assistantMessage,
  });
  const roundOneMaxOffset = Math.max(...roundOneEvents.map((event) => event.offset));

  // Round 2 — kill after the provider reports the request started, so the LLM
  // execution (in-memory only) dies mid-flight. The fresh incarnation's
  // dangling-started reconciliation must mark the dead attempt and re-execute.
  // (If the model finishes before the kill lands, this degenerates into an
  // ordinary turn and the reply assertion still holds.)
  await client.project.agents.sendMessage({
    agentPath,
    message: `crash mid request ${suffix}`,
    projectSlugOrId: project.id,
  });
  await readUntil({
    agentPath,
    client,
    projectId: project.id,
    afterOffset: roundOneMaxOffset,
    predicate: (event) => event.type === "events.iterate.com/cloudflare-ai/llm-request-started",
  });
  await client.project.agents.kill({ agentPath, projectSlugOrId: project.id });

  const roundTwoEvents = await readUntil({
    agentPath,
    client,
    projectId: project.id,
    afterOffset: roundOneMaxOffset,
    predicate: (event) =>
      event.type === "events.iterate.com/agents/web-message-sent" &&
      (event.payload as { message?: unknown }).message === assistantMessage,
  });

  // The kills really produced fresh incarnations: their re-handshakes append
  // subscriber-connected presence facts (one per processor subscription).
  expect(
    roundTwoEvents.filter(
      (event) => event.type === "events.iterate.com/stream/subscriber-connected",
    ).length,
  ).toBeGreaterThan(0);
  // No agent turn may end in an error.
  expect(roundTwoEvents.filter((event) => event.type.endsWith("error-occurred"))).toEqual([]);
});

test("lets agent scripts send visible agent responses through itx.chat.sendMessage", async () => {
  await using fixture = await createTestProjectFixture({ slugPrefix: "agents-chat-tool" });
  const { client, project } = fixture;
  const suffix = uniqueSuffix();
  const agentPath = `/agents/chat-tool-${suffix}`;
  const message = `agent chat tool provider proof ${suffix}`;

  await client.project.agents.runtimeState({
    agentPath,
    projectSlugOrId: project.id,
  });

  const output = await client.project.streams.append({
    projectSlugOrId: project.id,
    streamPath: agentPath,
    event: {
      type: "events.iterate.com/agent/output-added",
      payload: {
        content: dedent`
          \`\`\`js
            async (itx) => {
              await itx.chat.sendMessage({ message: ${JSON.stringify(message)} });
            }
            \`\`\`
        `,
      },
    },
  });

  const events = await readUntil({
    agentPath,
    client,
    projectId: project.id,
    afterOffset: "start",
    predicate: (event) =>
      event.type === "events.iterate.com/agents/web-message-sent" &&
      (event.payload as { message?: unknown }).message === message,
  });

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/itx/capability-provided",
      payload: expect.objectContaining({
        path: ["chat"],
      }),
    }),
  );
  const scriptRequested = events.find(
    (event) => event.type === "events.iterate.com/itx/script-execution-requested",
  );
  if (!scriptRequested) {
    throw new Error("Expected itx/script-execution-requested after agent output.");
  }
  const scriptRequestDelayMs =
    new Date(scriptRequested.createdAt).getTime() - new Date(output.event.createdAt).getTime();
  expect(scriptRequestDelayMs).toBeLessThan(1_000);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/agents/web-message-sent",
      payload: expect.objectContaining({
        message,
      }),
    }),
  );
});

test("project config worker customizes fresh agents by appending events", async () => {
  await using fixture = await createTestProjectFixture({ slugPrefix: "agent-context-config" });
  const { client, project } = fixture;
  const suffix = uniqueSuffix();
  const pusherPath = `/agents/config-pusher-${suffix}`;
  const customizedPath = `/agents/customized-${suffix}`;
  const promptMarker = `CUSTOM CONTEXT PROMPT ${suffix}`;
  const capabilityName = `acmeTool${suffix.replace(/-/g, "")}`;

  // Phase 1: push a config worker whose afterAppend reacts to new agent
  // streams. Deterministic: the push script is injected as agent output (no
  // LLM) and executed against the pusher agent's prepared workspace.
  await client.project.agents.runtimeState({ agentPath: pusherPath, projectSlugOrId: project.id });

  const configWorkerSource = [
    "export default {",
    '  async fetch() { return new Response("ok"); },',
    "",
    "  // The config worker is a stream processor: this receives every event on",
    "  // the project root stream. New agent streams announce themselves as",
    "  // child-stream-created; react by appending agent context events.",
    "  async processEvent({ event }, env) {",
    '    if (event.type !== "events.iterate.com/stream/child-stream-created") return;',
    "    const agentPath = event.payload.childPath;",
    `    if (!agentPath.startsWith(${JSON.stringify(`/agents/customized-`)})) return;`,
    "    await env.STREAMS.append({",
    "      streamPath: agentPath,",
    "      event: {",
    '        type: "events.iterate.com/agent/system-prompt-updated",',
    `        payload: { systemPrompt: ${JSON.stringify(promptMarker)} + " for " + agentPath },`,
    "      },",
    "    });",
    "    await env.STREAMS.append({",
    "      streamPath: agentPath,",
    "      event: {",
    '        type: "events.iterate.com/itx/capability-provided",',
    `        payload: { path: [${JSON.stringify(capabilityName)}], kind: "rpc", address: { type: "rpc", worker: { type: "loopback" }, entrypoint: "WorkerCapability" }, meta: { instructions: "Use itx.worker.${capabilityName}() (custom ${suffix})." } },`,
    "      },",
    "    });",
    "  },",
    "};",
    "",
  ].join("\n");
  const pushScript = [
    "async (itx) => {",
    `  await itx.workspace.writeFile('/project/worker.js', ${JSON.stringify(configWorkerSource)});`,
    "  await itx.workspace.git.add({ dir: '/project', filepath: 'worker.js' });",
    "  await itx.workspace.git.commit({ dir: '/project', message: 'add agent context config', author: { name: 'Agent', email: 'agent@iterate.com' } });",
    "  await itx.workspace.git.push({ dir: '/project', remote: 'origin', ref: 'main' });",
    "}",
  ].join("\n");
  await client.project.streams.append({
    projectSlugOrId: project.id,
    streamPath: pusherPath,
    event: {
      type: "events.iterate.com/agent/output-added",
      payload: { content: ["```js", pushScript, "```"].join("\n") },
    },
  });
  const pushEvents = await readUntil({
    agentPath: pusherPath,
    client,
    projectId: project.id,
    afterOffset: "start",
    predicate: (event) => event.type === "events.iterate.com/itx/script-execution-completed",
    timeoutMs: 120_000,
  });
  expect(
    requiredEvent(pushEvents, "events.iterate.com/itx/script-execution-completed").payload,
  ).toMatchObject({ ok: true });

  // Phase 2: a FRESH agent path wakes. Its stream creation announces a
  // child-stream-created on the project root stream; the project-config-worker
  // processor forwards it (blocking on a fresh checkout, so the just-pushed
  // worker sees it); the config worker appends the custom context.
  await client.project.agents.runtimeState({
    agentPath: customizedPath,
    projectSlugOrId: project.id,
  });
  const events = await readUntil({
    agentPath: customizedPath,
    client,
    projectId: project.id,
    afterOffset: "start",
    predicate: (event) =>
      event.type === "events.iterate.com/agent/system-prompt-updated" &&
      typeof (event.payload as { systemPrompt?: unknown }).systemPrompt === "string" &&
      ((event.payload as { systemPrompt?: string }).systemPrompt ?? "").includes(promptMarker),
    timeoutMs: 120_000,
  });

  // The custom prompt must be what the agent actually runs with: either the
  // platform defaults yielded to it (config worker won the race) or it landed
  // after them (last-wins reducer). Both orders leave it as the LAST prompt.
  const lastPrompt = requiredEvent(
    [...events].reverse(),
    "events.iterate.com/agent/system-prompt-updated",
  );
  const lastPromptText = requiredStringPayload(lastPrompt, "systemPrompt");
  expect(lastPromptText).toContain(promptMarker);
  expect(lastPromptText).toContain(customizedPath);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/itx/capability-provided",
      payload: expect.objectContaining({ path: [capabilityName] }),
    }),
  );
}, 240_000);

test("lets agent chat update the project repo through the prepared workspace", async () => {
  await using fixture = await createTestProjectFixture({ slugPrefix: "agent-workspace" });
  const { client, project } = fixture;
  const suffix = uniqueSuffix();
  const agentPath = `/agents/workspace-${suffix}`;

  await client.project.agents.runtimeState({
    agentPath,
    projectSlugOrId: project.id,
  });
  await client.project.agents.sendMessage({
    agentPath,
    message: "add a file called folder/banana.txt to the iterate config repo and push",
    projectSlugOrId: project.id,
  });

  await readUntil({
    agentPath,
    client,
    projectId: project.id,
    afterOffset: "start",
    predicate: (event) =>
      event.type === "events.iterate.com/itx/script-execution-completed" &&
      (event.payload as { ok?: unknown }).ok === true,
    timeoutMs: 120_000,
  });
  const events = await readUntil({
    agentPath,
    client,
    projectId: project.id,
    afterOffset: "start",
    predicate: (event) => event.type === "events.iterate.com/itx/script-execution-completed",
    timeoutMs: 30_000,
  });

  const output = requiredEvent(events, "events.iterate.com/agent/output-added");
  const scriptRequested = requiredEvent(
    events,
    "events.iterate.com/itx/script-execution-requested",
  );
  const scriptCompleted = requiredEvent(
    events,
    "events.iterate.com/itx/script-execution-completed",
  );
  const generatedCode = requiredStringPayload(output, "content");
  const requestedCode = requiredStringPayload(scriptRequested, "code");

  expect(generatedCode).toContain("itx.workspace.writeFile");
  expect(generatedCode).toContain("itx.workspace.gitCommit");
  expect(generatedCode).toContain("itx.workspace.gitPush");
  expect(generatedCode).toContain("/project");
  expect(generatedCode).toContain("folder/banana.txt");
  expect(generatedCode).not.toContain("gitClone");
  expect(generatedCode).not.toContain(".repos");
  expect(requestedCode).not.toContain("gitClone");
  // Per-call events died with codemode; the workspace ops are proven by the
  // generated code above plus the execution completing ok (the git push
  // would fail the script otherwise).
  expect(scriptCompleted).toMatchObject({ payload: { ok: true } });
  expect(events.filter((event) => event.type === "events.iterate.com/core/error-occurred")).toEqual(
    [],
  );
}, 180_000);

test("renders codemode completions as direct auto-triggering agent inputs", async () => {
  await using fixture = await createTestProjectFixture({ slugPrefix: "agent-codemode-completion" });
  const { client, project } = fixture;
  const suffix = uniqueSuffix();
  const agentPath = `/agents/codemode-completion-${suffix}`;
  const returnedScriptExecutionId = `returned-${suffix}`;
  const threwScriptExecutionId = `threw-${suffix}`;

  await client.project.agents.runtimeState({
    agentPath,
    projectSlugOrId: project.id,
  });

  const returned = await client.project.streams.append({
    projectSlugOrId: project.id,
    streamPath: agentPath,
    event: {
      type: "events.iterate.com/itx/script-execution-completed",
      idempotencyKey: `agent-codemode-completion-returned:${suffix}`,
      payload: {
        durationMs: 12,
        executionId: returnedScriptExecutionId,
        ok: true,
        result: { ok: true, suffix },
      },
    },
  });
  await client.project.streams.append({
    projectSlugOrId: project.id,
    streamPath: agentPath,
    event: {
      type: "events.iterate.com/itx/script-execution-completed",
      idempotencyKey: `agent-codemode-completion-threw:${suffix}`,
      payload: {
        durationMs: 12,
        error: `expected codemode failure ${suffix}`,
        executionId: threwScriptExecutionId,
        ok: false,
      },
    },
  });

  const events = await readUntil({
    agentPath,
    client,
    projectId: project.id,
    afterOffset: returned.event.offset - 1,
    predicate: (event) =>
      event.type === "events.iterate.com/agent/input-added" &&
      typeof (event.payload as { content?: unknown }).content === "string" &&
      (event.payload as { content: string }).content.includes(threwScriptExecutionId),
  });

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/agent/input-added",
      payload: expect.objectContaining({
        content: expect.stringContaining(returnedScriptExecutionId),
        llmRequestPolicy: { behaviour: "after-current-request" },
      }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/agent/input-added",
      payload: expect.objectContaining({
        content: expect.stringContaining("expected codemode failure"),
        llmRequestPolicy: { behaviour: "after-current-request" },
      }),
    }),
  );
  expect(
    events.some(
      (event) =>
        event.type === "events.iterate.com/agents/web-message-sent" &&
        typeof (event.payload as { message?: unknown }).message === "string" &&
        (event.payload as { message: string }).message.includes("Codemode threw"),
    ),
  ).toBe(false);
});

itIfSlackBotToken(
  "lets a real agent conversation post to Slack through codemode",
  async () => {
    await using fixture = await createTestProjectFixture({ slugPrefix: "agent-slack" });
    const { client, project } = fixture;
    const suffix = uniqueSuffix();
    const agentPath = `/agents/slack-${suffix}`;
    const slackChannelId = await requireSlackChannelId();
    const slackText = `OS agent Slack proof ${suffix}`;

    await client.project.agents.configurePreset({
      basePath: agentPath,
      events: [],
      model: "gpt-5.5",
      projectSlugOrId: project.id,
      provider: "openai-ws",
      runOpts: {},
      systemPrompt: [
        "For every user message, reply with exactly one fenced JavaScript code block and no surrounding prose.",
        "The block must evaluate to an async function.",
        "Use this exact code body:",
        `async (itx) => {
  const slack = await itx.slack.chat.postMessage({
    channel: ${JSON.stringify(slackChannelId)},
    text: ${JSON.stringify(slackText)}
  });
  await itx.chat.sendMessage({
    message: "posted slack " + slack.channel + " " + slack.ts
  });
}`,
      ].join("\n"),
    });

    await client.project.agents.runtimeState({
      agentPath,
      projectSlugOrId: project.id,
    });
    await client.project.agents.sendMessage({
      agentPath,
      message: "post the Slack proof now",
      projectSlugOrId: project.id,
    });

    const events = await readUntil({
      agentPath,
      client,
      projectId: project.id,
      afterOffset: "start",
      predicate: (event) =>
        event.type === "events.iterate.com/agents/web-message-sent" &&
        typeof (event.payload as { message?: unknown }).message === "string" &&
        (event.payload as { message: string }).message.startsWith("posted slack "),
    });
    const output = requiredEvent(events, "events.iterate.com/agent/output-added");
    const scriptRequested = requiredEvent(
      events,
      "events.iterate.com/itx/script-execution-requested",
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/itx/capability-provided",
        payload: expect.objectContaining({
          path: ["slack"],
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/agent/input-added",
        payload: expect.objectContaining({
          content: expect.stringContaining("slack.chat.postMessage"),
        }),
      }),
    );
    expect(
      new Date(scriptRequested.createdAt).getTime() - new Date(output.createdAt).getTime(),
    ).toBeLessThan(1_000);
    expect(maxGapAfter(events, output.offset)).toBeLessThan(3_000);
    expect(
      events.filter((event) => event.type === "events.iterate.com/core/error-occurred"),
    ).toEqual([]);
  },
  180_000,
);

itIfSlackBotToken(
  "routes Slack webhooks into slack-agent streams and executes bang command replies",
  async () => {
    await using fixture = await createTestProjectFixture({ slugPrefix: "slack-agent-route" });
    const { client, project } = fixture;
    const suffix = uniqueSuffix();
    const slackChannelId = await requireSlackChannelId();
    const rootText = `OS slack-agent route proof ${suffix}`;
    const replyText = `OS slack-agent bang proof ${suffix}`;
    const rootMessage = await postSlackMessage({
      channel: slackChannelId,
      text: rootText,
      token: requireSlackToken(),
    });
    const routedAgentPath = slackAgentPath({
      channel: slackChannelId,
      threadTs: rootMessage.ts,
    });

    await client.project.streams.append({
      projectSlugOrId: project.id,
      streamPath: "/integrations/slack",
      event: slackProcessorSubscriptionEvent({ projectId: project.id, suffix }),
    });

    await client.project.streams.append({
      projectSlugOrId: project.id,
      streamPath: "/integrations/slack",
      event: {
        type: "events.iterate.com/slack/webhook-received",
        idempotencyKey: `slack-agent-e2e-webhook:${suffix}`,
        payload: {
          slackTeamId: "T_E2E",
          body: {
            type: "event_callback",
            team_id: "T_E2E",
            event_id: `Ev${suffix}`,
            event: {
              type: "message",
              channel: slackChannelId,
              channel_type: "channel",
              user: "U_E2E",
              ts: rootMessage.ts,
              event_ts: rootMessage.ts,
              text: `!slack.chat.postMessage({ channel: ${JSON.stringify(slackChannelId)}, thread_ts: ${JSON.stringify(rootMessage.ts)}, text: ${JSON.stringify(replyText)} })`,
            },
          },
        },
      },
    });

    const events = await readUntil({
      agentPath: routedAgentPath,
      client,
      projectId: project.id,
      afterOffset: "start",
      predicate: (event) =>
        event.type === "events.iterate.com/itx/script-execution-completed" &&
        (event.payload as { ok?: unknown }).ok === true,
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
        payload: expect.objectContaining({
          subscriptionKey: expect.stringContaining("slack-agent:"),
          subscriber: expect.objectContaining({
            type: "callable",
            callable: expect.objectContaining({
              transformInput: { shallowMerge: { processorName: "slack-agent" } },
            }),
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
        payload: expect.objectContaining({
          subscriptionKey: expect.stringContaining("agent:"),
          subscriber: expect.objectContaining({
            type: "callable",
            callable: expect.objectContaining({
              transformInput: { shallowMerge: { processorName: "agent" } },
            }),
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/slack/thread-route-configured",
        payload: {
          channel: slackChannelId,
          threadTs: rootMessage.ts,
          streamPath: routedAgentPath,
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/itx/capability-provided",
        payload: expect.objectContaining({
          path: ["slack"],
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/os-agent/llm-provider-selected",
        payload: { provider: "openai-ws" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/openai-ws/config-updated",
        payload: expect.objectContaining({
          model: "gpt-5.5",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/agent/llm-config-updated",
        payload: expect.objectContaining({
          model: "gpt-5.5",
        }),
      }),
    );
    expect(events.filter((event) => event.type.startsWith("events.iterate.com/agents/"))).toEqual(
      [],
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/itx/script-execution-requested",
        payload: expect.objectContaining({
          code: expect.stringContaining("itx.slack.chat.postMessage"),
        }),
      }),
    );

    const debugAfterOffset = Math.max(...events.map((event) => event.offset));
    const debugMessageTs = `${Date.now()}.123456`;
    await client.project.streams.append({
      projectSlugOrId: project.id,
      streamPath: "/integrations/slack",
      event: {
        type: "events.iterate.com/slack/webhook-received",
        idempotencyKey: `slack-agent-e2e-debug-webhook:${suffix}`,
        payload: {
          slackTeamId: "T_E2E",
          body: {
            type: "event_callback",
            team_id: "T_E2E",
            event_id: `EvDebug${suffix}`,
            event: {
              type: "message",
              channel: slackChannelId,
              channel_type: "channel",
              user: "U_E2E",
              ts: debugMessageTs,
              thread_ts: rootMessage.ts,
              event_ts: debugMessageTs,
              text: "!debug",
            },
          },
        },
      },
    });

    const debugEvents = await readUntil({
      agentPath: routedAgentPath,
      client,
      projectId: project.id,
      afterOffset: debugAfterOffset,
      predicate: (event) =>
        event.type === "events.iterate.com/itx/script-execution-completed" &&
        (event.payload as { ok?: unknown }).ok === true,
    });
    expect(debugEvents).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/itx/script-execution-requested",
        payload: expect.objectContaining({
          code: expect.stringContaining("const debug = await itx.debug();"),
        }),
      }),
    );
    // Per-call events are gone with codemode: the slack post inside the debug
    // script is verified by the execution completing ok (and the real Slack
    // thread). The stream-URL/sanitization asserts rode on those events.
    expect(
      debugEvents.filter((event) => event.type.startsWith("events.iterate.com/agents/")),
    ).toEqual([]);
    expect(
      events.filter(
        (event) =>
          event.type === "events.iterate.com/agent/input-added" &&
          typeof (event.payload as { content?: unknown }).content === "string" &&
          (event.payload as { content: string }).content.includes("Reply requirement:"),
      ),
    ).toEqual([]);
    expect(
      events.filter((event) => event.type === "events.iterate.com/core/error-occurred"),
    ).toEqual([]);
  },
  180_000,
);

itIfSlackBotToken(
  "schedules and completes an LLM request for a plain routed Slack message",
  async () => {
    // Regression test for the 2026-06-10 prod outage: on a freshly
    // bootstrapped Slack thread stream, the slack-agent processor rendered
    // the webhook into a triggering agent input before the agent processor's
    // subscription was configured. The host anchored side effects at the
    // subscription-configured offset, so the trigger was replayed as
    // historical and no LLM request was ever scheduled — the agent never
    // replied. The subscriber-connected reconciliation must recover the
    // skipped trigger, so the LLM turn completes no matter which side wins
    // the bootstrap race.
    await using fixture = await createTestProjectFixture({ slugPrefix: "slack-agent-llm" });
    const { client, project } = fixture;
    const suffix = uniqueSuffix();
    const slackChannelId = await requireSlackChannelId();
    const rootText = `OS slack-agent llm trigger proof ${suffix}`;
    const rootMessage = await postSlackMessage({
      channel: slackChannelId,
      text: rootText,
      token: requireSlackToken(),
    });
    const routedAgentPath = slackAgentPath({
      channel: slackChannelId,
      threadTs: rootMessage.ts,
    });

    await client.project.streams.append({
      projectSlugOrId: project.id,
      streamPath: "/integrations/slack",
      event: slackProcessorSubscriptionEvent({ projectId: project.id, suffix }),
    });

    await client.project.streams.append({
      projectSlugOrId: project.id,
      streamPath: "/integrations/slack",
      event: {
        type: "events.iterate.com/slack/webhook-received",
        idempotencyKey: `slack-agent-e2e-llm-webhook:${suffix}`,
        payload: {
          slackTeamId: "T_E2E",
          body: {
            type: "event_callback",
            team_id: "T_E2E",
            event_id: `EvLlm${suffix}`,
            event: {
              type: "message",
              channel: slackChannelId,
              channel_type: "channel",
              user: "U_E2E",
              ts: rootMessage.ts,
              event_ts: rootMessage.ts,
              text: `please acknowledge: ${rootText}`,
            },
          },
        },
      },
    });

    const events = await readUntil({
      agentPath: routedAgentPath,
      client,
      projectId: project.id,
      afterOffset: "start",
      predicate: (event) =>
        event.type === "events.iterate.com/agent/llm-request-completed" &&
        (event.payload as { result?: { status?: unknown } }).result?.status === "success",
      timeoutMs: 150_000,
    });

    // The durable handoff chain the regression silently dropped: trigger →
    // scheduled (keyed off the triggering input, so live path and recovery
    // converge) → requested → completed.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/agent/llm-request-scheduled",
        idempotencyKey: expect.stringMatching(/^agent\/llm-request-scheduled@\d+$/),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/agent/llm-request-requested",
      }),
    );
    expect(
      events.filter((event) => event.type === "events.iterate.com/stream/error-occurred"),
    ).toEqual([]);
  },
  180_000,
);

async function requireSlackChannelId() {
  const channels = await listSlackChannels(requireSlackToken());
  const channel = channels.find(
    (candidate) => candidate.name === "slack-agent-e2e-test" && candidate.is_member === true,
  );
  if (!channel) {
    throw new Error(
      "APP_CONFIG_SLACK_BOT_TOKEN is set, but the bot is not a member of #slack-agent-e2e-test.",
    );
  }
  return channel.id;
}

function requireSlackToken() {
  const token = process.env.APP_CONFIG_SLACK_BOT_TOKEN?.trim();
  if (!token) throw new Error("APP_CONFIG_SLACK_BOT_TOKEN is required for Slack e2e tests.");
  return token;
}

async function postSlackMessage(input: { channel: string; text: string; token: string }) {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    body: JSON.stringify({
      channel: input.channel,
      text: input.text,
    }),
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json; charset=utf-8",
    },
    method: "POST",
  });
  const result = (await response.json()) as
    | {
        channel: string;
        ok: true;
        ts: string;
      }
    | {
        error?: string;
        ok: false;
      };
  if (!result.ok) {
    throw new Error(`Slack chat.postMessage failed: ${result.error ?? response.status}`);
  }
  return result;
}

async function listSlackChannels(token: string) {
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL("https://slack.com/api/conversations.list");
    url.searchParams.set("exclude_archived", "true");
    url.searchParams.set("limit", "200");
    url.searchParams.set("types", "public_channel,private_channel");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    const result = (await response.json()) as SlackConversationsListResponse;
    if (!result.ok) {
      throw new Error(`Slack conversations.list failed: ${result.error ?? response.status}`);
    }
    channels.push(...result.channels);
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return channels;
}

async function readUntil(input: {
  afterOffset: number | "start";
  agentPath: string;
  client: OsClient;
  predicate(event: Event): boolean;
  projectId: string;
  timeoutMs?: number;
}) {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 120_000;
  while (Date.now() - startedAt < timeoutMs) {
    const result = await input.client.project.streams.read({
      afterOffset: input.afterOffset,
      projectSlugOrId: input.projectId,
      streamPath: input.agentPath,
    });
    if (result.events.some(input.predicate)) return result.events;
    await delay(1_000);
  }

  const result = await input.client.project.streams.read({
    afterOffset: input.afterOffset,
    projectSlugOrId: input.projectId,
    streamPath: input.agentPath,
  });
  throw new Error(
    `Timed out waiting for agent stream event. Saw: ${JSON.stringify(result.events)}`,
  );
}

function requiredEvent(events: readonly Event[], type: string) {
  const event = events.find((item) => item.type === type);
  if (!event) throw new Error(`Expected ${type}.`);
  return event;
}

function requiredStringPayload(event: Event, key: string) {
  const payload = event.payload;
  if (payload == null || typeof payload !== "object" || !(key in payload)) {
    throw new Error(`Expected string payload key ${key}.`);
  }
  const value = payload[key as keyof typeof payload];
  if (typeof value !== "string") {
    throw new Error(`Expected string payload key ${key}.`);
  }
  return value;
}

function slackAgentPath(input: { channel: string; threadTs: string }) {
  return `/agents/slack/${sanitizeSlackPathPart(input.channel)}/ts-${sanitizeSlackPathPart(input.threadTs)}`;
}

function sanitizeSlackPathPart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function slackProcessorSubscriptionEvent(input: { projectId: string; suffix: string }) {
  return {
    type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
    idempotencyKey: `slack-integration-e2e-subscription:${input.projectId}:${input.suffix}`,
    payload: {
      // Mirrors SlackIntegrationDurableObject.ensureIntegrationSubscription:
      // a callable subscriber that dials the SLACK_INTEGRATION host DO.
      subscriptionKey: `slack:${input.projectId}`,
      subscriber: durableObjectProcessorSubscriber({
        bindingName: "SLACK_INTEGRATION",
        durableObjectName: getSlackIntegrationDurableObjectName(input.projectId),
        processorName: "slack",
      }),
    },
  } as const;
}

function maxGapAfter(events: readonly Event[], afterOffset: number) {
  const tail = events
    .filter((event) => event.offset >= afterOffset)
    .toSorted((left, right) => left.offset - right.offset);
  let maxGapMs = 0;
  for (let index = 1; index < tail.length; index += 1) {
    const previous = tail[index - 1];
    const current = tail[index];
    maxGapMs = Math.max(
      maxGapMs,
      new Date(current.createdAt).getTime() - new Date(previous.createdAt).getTime(),
    );
  }
  return maxGapMs;
}

function uniqueSuffix() {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
