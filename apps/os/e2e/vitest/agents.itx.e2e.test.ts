/**
 * Deployment-targeted tests for OS project agents, driven through itx (the same
 * handle the browser/REPL/CLI use). These replace the oRPC originals preserved
 * as agents.orpc-legacy.ts.
 *
 *   doppler run --project os --config preview_2 -- \
 *   pnpm --dir apps/os e2e -t "agent"
 *
 * Transport mapping from the oRPC reference:
 *   - agents.runtimeState({agentPath})  → itx.streams.create({streamPath})
 *       (the fresh-agent bootstrap door the dashboard new-agent flow uses;
 *        it wires the agent's default processor subscriptions)
 *   - agents.sendMessage({agentPath,…}) → itx.agents.sendMessage({agentPath,…})
 *       (force-wakes the agent DO via ensureStartedAndCaughtUp)
 *   - agents.kill(…)                    → no itx door exists; the crash-recovery
 *       case is skipped below until the agents capability exposes a kill.
 *   - project.streams.{append,appendBatch,read} → itx.streams.get(path).{append,appendBatch,getEvents};
 *       getEvents() returns Event[] directly (no { events } wrapper).
 */
import { expect, test } from "vitest";
import type { Event, EventInput } from "@iterate-com/shared/streams/types";
import dedent from "dedent";
import { createTestProject } from "../test-support/create-test-project.ts";
import { DEFAULT_WORKERS_AI_AGENT_MODEL } from "~/domains/agents/stream-processors/agent/contract.ts";
import { getSlackIntegrationDurableObjectName } from "~/domains/slack/slack-naming.ts";
import { durableObjectProcessorSubscriber } from "~/domains/streams/engine/shared/callable-subscriber.ts";

type ProjectItx = ReturnType<Awaited<ReturnType<typeof createTestProject>>["itx"]>;

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

test("can configure Cloudflare AI Gateway as the provider for an agent stream", async () => {
  await using fixture = await createTestProject({ slugPrefix: "agent-cloudflare-setup" });
  using itx = fixture.itx();
  const suffix = uniqueSuffix();
  const agentPath = `/agents/cloudflare-setup-${suffix}`;
  const assistantMessage = `cloudflare ai gateway chat proof ${suffix}`;

  await appendAgentSetup({
    agentPath,
    itx,
    model: DEFAULT_WORKERS_AI_AGENT_MODEL,
    projectId: fixture.project.id,
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

  await itx.agents.sendMessage({
    agentPath,
    message: `cloudflare provider preset proof ${suffix}`,
  });

  const events = await readUntil({
    agentPath,
    itx,
    afterOffset: "start",
    predicate: (event) =>
      event.type === "events.iterate.com/agents/web-message-sent" &&
      (event.payload as { message?: unknown }).message === assistantMessage,
  });

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/agent/llm-provider-selected",
      payload: { model: DEFAULT_WORKERS_AI_AGENT_MODEL, provider: "cloudflare-ai" },
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
  await using fixture = await createTestProject({ slugPrefix: "agent-web-convo" });
  using itx = fixture.itx();
  const suffix = uniqueSuffix();
  const agentPath = `/agents/web-convo-${suffix}`;
  const marker = `pong-${suffix}`;

  await itx.agents.sendMessage({
    agentPath,
    message: `Please reply in this chat with a short message that contains exactly this token: ${marker}`,
  });

  const events = await readUntil({
    agentPath,
    itx,
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
  await using fixture = await createTestProject({ slugPrefix: "agent-default-openai" });
  using itx = fixture.itx();
  const suffix = uniqueSuffix();
  const agentPath = `/agents/default-openai-${suffix}`;

  await itx.agents.sendMessage({
    agentPath,
    message: `default OpenAI proof ${suffix}`,
  });

  const events = await readUntil({
    agentPath,
    itx,
    afterOffset: "start",
    predicate: (event) =>
      event.type === "events.iterate.com/openai-ws/llm-request-completed" &&
      (event.payload as { result?: { status?: unknown } }).result?.status === "success",
  });

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/agent/llm-provider-selected",
      payload: { model: "gpt-5.5", provider: "openai-ws" },
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

// The oRPC reference also killed the agent host DO mid-turn to prove crash
// recovery (see "recovers and still replies when the agent host durable object
// is killed mid-turn" in agents.orpc-legacy.ts). itx's agents capability
// exposes only sendMessage today — there is no kill door — so the mid-turn
// kill cannot be driven over itx yet. Restore this once
// AgentsCapability exposes kill on the itx surface (known-capabilities.ts).
test.skip("recovers and still replies when the agent host durable object is killed mid-turn", () => {});

test("lets agent scripts send visible agent responses through itx.chat.sendMessage", async () => {
  await using fixture = await createTestProject({ slugPrefix: "agents-chat-tool" });
  using itx = fixture.itx();
  const suffix = uniqueSuffix();
  const agentPath = `/agents/chat-tool-${suffix}`;
  const message = `agent chat tool provider proof ${suffix}`;

  // Bootstrap the fresh agent (wires its default subscriptions) before driving
  // it with a directly-appended output event.
  await itx.streams.create({ streamPath: agentPath });

  // append returns the bare appended Event (offset, createdAt, …); the cast
  // steps past capnweb's lossy stub-type projection of the branded Event type.
  const output = (await itx.streams.get(agentPath).append({
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
  })) as unknown as Event;

  const events = await readUntil({
    agentPath,
    itx,
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
    new Date(scriptRequested.createdAt).getTime() - new Date(output.createdAt).getTime();
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
  await using fixture = await createTestProject({ slugPrefix: "agent-context-config" });
  using itx = fixture.itx();
  const suffix = uniqueSuffix();
  const pusherPath = `/agents/config-pusher-${suffix}`;
  const customizedPath = `/agents/customized-${suffix}`;
  const promptMarker = `CUSTOM CONTEXT PROMPT ${suffix}`;
  const capabilityName = `acmeTool${suffix.replace(/-/g, "")}`;

  // Phase 1: push a config worker whose afterAppend reacts to new agent
  // streams. Deterministic: the push script is injected as agent output (no
  // LLM) and executed against the pusher agent's prepared workspace.
  await itx.streams.create({ streamPath: pusherPath });

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
  await itx.streams.get(pusherPath).append({
    event: {
      type: "events.iterate.com/agent/output-added",
      payload: { content: ["```js", pushScript, "```"].join("\n") },
    },
  });
  const pushEvents = await readUntil({
    agentPath: pusherPath,
    itx,
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
  await itx.streams.create({ streamPath: customizedPath });
  const events = await readUntil({
    agentPath: customizedPath,
    itx,
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
  await using fixture = await createTestProject({ slugPrefix: "agent-workspace" });
  using itx = fixture.itx();
  const suffix = uniqueSuffix();
  const agentPath = `/agents/workspace-${suffix}`;

  await itx.agents.sendMessage({
    agentPath,
    message: "add a file called folder/banana.txt to the iterate config repo and push",
  });

  await readUntil({
    agentPath,
    itx,
    afterOffset: "start",
    predicate: (event) =>
      event.type === "events.iterate.com/itx/script-execution-completed" &&
      (event.payload as { ok?: unknown }).ok === true,
    timeoutMs: 120_000,
  });
  const events = await readUntil({
    agentPath,
    itx,
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
  await using fixture = await createTestProject({ slugPrefix: "agent-codemode-completion" });
  using itx = fixture.itx();
  const suffix = uniqueSuffix();
  const agentPath = `/agents/codemode-completion-${suffix}`;
  const returnedScriptExecutionId = `returned-${suffix}`;
  const threwScriptExecutionId = `threw-${suffix}`;

  await itx.streams.create({ streamPath: agentPath });

  await itx.streams.get(agentPath).append({
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
  await itx.streams.get(agentPath).append({
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
    itx,
    afterOffset: "start",
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
    await using fixture = await createTestProject({ slugPrefix: "agent-slack" });
    using itx = fixture.itx();
    const suffix = uniqueSuffix();
    const agentPath = `/agents/slack/manual-${suffix}`;
    const slackChannelId = await requireSlackChannelId();
    const slackText = `OS agent Slack proof ${suffix}`;

    await appendAgentSetup({
      agentPath,
      itx,
      model: "gpt-5.5",
      projectId: fixture.project.id,
      provider: "openai-ws",
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

    await itx.agents.sendMessage({
      agentPath,
      message: "post the Slack proof now",
    });

    const events = await readUntil({
      agentPath,
      itx,
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
    await using fixture = await createTestProject({ slugPrefix: "slack-agent-route" });
    using itx = fixture.itx();
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

    await itx.streams.get("/integrations/slack").append({
      event: slackProcessorSubscriptionEvent({ projectId: fixture.project.id, suffix }),
    });

    await itx.streams.get("/integrations/slack").append({
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
      itx,
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
        type: "events.iterate.com/agent/llm-provider-selected",
        payload: {
          model: "gpt-5.5",
          provider: "openai-ws",
        },
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
    await itx.streams.get("/integrations/slack").append({
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
      itx,
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
    // Regression test for the 2026-06-10 prod outage: on a freshly routed Slack
    // thread stream, the webhook-to-agent-input and agent LLM scheduling setup
    // can be configured in either order. Catch-up replay must still run the
    // idempotent side effects needed to complete the LLM turn.
    await using fixture = await createTestProject({ slugPrefix: "slack-agent-llm" });
    using itx = fixture.itx();
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

    await itx.streams.get("/integrations/slack").append({
      event: slackProcessorSubscriptionEvent({ projectId: fixture.project.id, suffix }),
    });

    await itx.streams.get("/integrations/slack").append({
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
      itx,
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
  itx: ProjectItx;
  predicate(event: Event): boolean;
  timeoutMs?: number;
}) {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 120_000;
  const afterOffset = input.afterOffset === "start" ? 0 : input.afterOffset;
  while (Date.now() - startedAt < timeoutMs) {
    // itx's streams.getEvents returns the Event[] directly (no { events } wrapper).
    const events = (await input.itx.streams
      .get(input.agentPath)
      .getEvents({ afterOffset })) as unknown as Event[];
    if (events.some(input.predicate)) return events;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const events = (await input.itx.streams
    .get(input.agentPath)
    .getEvents({ afterOffset })) as unknown as Event[];
  throw new Error(`Timed out waiting for agent stream event. Saw: ${JSON.stringify(events)}`);
}

async function appendAgentSetup(input: {
  agentPath: string;
  itx: ProjectItx;
  model: string;
  projectId: string;
  provider: "openai-ws" | "cloudflare-ai";
  systemPrompt: string;
}) {
  const events: EventInput[] = [
    {
      type: "events.iterate.com/agent/llm-provider-selected",
      idempotencyKey: "e2e-agent-setup:provider",
      payload: { model: input.model, provider: input.provider },
    },
    {
      type: "events.iterate.com/agent/system-prompt-updated",
      idempotencyKey: "e2e-agent-setup:system-prompt",
      payload: { systemPrompt: input.systemPrompt },
    },
    ...agentProcessorSubscriptionConfiguredEvents({
      agentPath: input.agentPath,
      processorSlugs: ["agent", input.provider],
      projectId: input.projectId,
    }),
  ];

  await input.itx.streams.get(input.agentPath).appendBatch({ events });
}

function agentProcessorSubscriptionConfiguredEvents(input: {
  agentPath: string;
  processorSlugs: readonly string[];
  projectId: string;
}): EventInput[] {
  return input.processorSlugs.map((processorSlug) => ({
    type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
    idempotencyKey: `agent-processor-subscription:${input.projectId}:${input.agentPath}:${processorSlug}:callable`,
    payload: {
      subscriptionKey: `agent:${input.projectId}:${input.agentPath}:${processorSlug}`,
      subscriber: durableObjectProcessorSubscriber({
        bindingName: "AGENT",
        durableObjectName: `${input.projectId}:${input.agentPath}`,
        processorName: processorSlug,
      }),
    },
  }));
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
