/**
 * Deployment-targeted tests for OS project agents.
 *
 * These run through public oRPC/OpenAPI routes against a live OS deployment:
 *
 *   doppler run --project os --config preview_2 -- \
 *   pnpm --dir apps/os e2e -t "project agents codemode"
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
        async (ctx) => {
          await ctx.chat.sendMessage({ message: ${JSON.stringify(assistantMessage)} });
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
      event.type === "events.iterate.com/agent-chat/assistant-response-added" &&
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
      type: "events.iterate.com/codemode/script-execution-requested",
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/agent-chat/assistant-response-added",
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
        async (ctx) => {
          await ctx.chat.sendMessage({ message: ${JSON.stringify(assistantMessage)} });
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
      event.type === "events.iterate.com/agent-chat/assistant-response-added" &&
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
      event.type === "events.iterate.com/agent-chat/assistant-response-added" &&
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

test("lets codemode send visible agent responses through ctx.chat.sendMessage", async () => {
  await using fixture = await createTestProjectFixture({ slugPrefix: "agent-chat-tool" });
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
            async (ctx) => {
              await ctx.chat.sendMessage({ message: ${JSON.stringify(message)} });
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
      event.type === "events.iterate.com/agent-chat/assistant-response-added" &&
      (event.payload as { message?: unknown }).message === message,
  });

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/codemode/tool-provider-registered",
      payload: expect.objectContaining({
        path: ["chat"],
      }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/codemode/function-call-requested",
      payload: expect.objectContaining({
        path: ["chat", "sendMessage"],
        providerPath: ["chat"],
      }),
    }),
  );
  const scriptRequested = events.find(
    (event) => event.type === "events.iterate.com/codemode/script-execution-requested",
  );
  if (!scriptRequested) {
    throw new Error("Expected codemode/script-execution-requested after agent output.");
  }
  const scriptRequestDelayMs =
    new Date(scriptRequested.createdAt).getTime() - new Date(output.event.createdAt).getTime();
  expect(scriptRequestDelayMs).toBeLessThan(1_000);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/agent-chat/assistant-response-added",
      payload: expect.objectContaining({
        channel: "web",
        message,
      }),
    }),
  );
});

test("lets agent chat update iterate-config through the prepared workspace", async () => {
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
      event.type === "events.iterate.com/codemode/function-call-completed" &&
      eventPath(event).join(".") === "workspace.git.push",
    timeoutMs: 120_000,
  });
  const events = await readUntil({
    agentPath,
    client,
    projectId: project.id,
    afterOffset: "start",
    predicate: (event) => event.type === "events.iterate.com/codemode/script-execution-completed",
    timeoutMs: 30_000,
  });

  const output = requiredEvent(events, "events.iterate.com/agent/output-added");
  const scriptRequested = requiredEvent(
    events,
    "events.iterate.com/codemode/script-execution-requested",
  );
  const scriptCompleted = requiredEvent(
    events,
    "events.iterate.com/codemode/script-execution-completed",
  );
  const generatedCode = requiredStringPayload(output, "content");
  const requestedCode = requiredStringPayload(scriptRequested, "code");

  expect(generatedCode).toContain("ctx.workspace.writeFile");
  expect(generatedCode).toContain("ctx.workspace.git.commit");
  expect(generatedCode).toContain("ctx.workspace.git.push");
  expect(generatedCode).toContain("/iterate-config");
  expect(generatedCode).toContain("folder/banana.txt");
  expect(generatedCode).not.toContain("git.clone");
  expect(generatedCode).not.toContain("ctx.repos");
  expect(requestedCode).not.toContain("git.clone");
  expect(events.map((event) => eventPath(event).join("."))).toEqual(
    expect.arrayContaining([
      "workspace.writeFile",
      "workspace.git.add",
      "workspace.git.commit",
      "workspace.git.push",
    ]),
  );
  expect(scriptCompleted).toMatchObject({ payload: { outcome: { status: "returned" } } });
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
      type: "events.iterate.com/codemode/script-execution-completed",
      idempotencyKey: `agent-codemode-completion-returned:${suffix}`,
      payload: {
        durationMs: 12,
        outcome: { status: "returned", value: { ok: true, suffix } },
        scriptExecutionId: returnedScriptExecutionId,
      },
    },
  });
  await client.project.streams.append({
    projectSlugOrId: project.id,
    streamPath: agentPath,
    event: {
      type: "events.iterate.com/codemode/script-execution-completed",
      idempotencyKey: `agent-codemode-completion-threw:${suffix}`,
      payload: {
        durationMs: 12,
        outcome: { status: "threw", error: `expected codemode failure ${suffix}` },
        scriptExecutionId: threwScriptExecutionId,
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
        event.type === "events.iterate.com/agent-chat/assistant-response-added" &&
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
        `async (ctx) => {
  const slack = await ctx.slack.chat.postMessage({
    channel: ${JSON.stringify(slackChannelId)},
    text: ${JSON.stringify(slackText)}
  });
  await ctx.chat.sendMessage({
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
        event.type === "events.iterate.com/agent-chat/assistant-response-added" &&
        typeof (event.payload as { message?: unknown }).message === "string" &&
        (event.payload as { message: string }).message.startsWith("posted slack "),
    });
    const output = requiredEvent(events, "events.iterate.com/agent/output-added");
    const scriptRequested = requiredEvent(
      events,
      "events.iterate.com/codemode/script-execution-requested",
    );
    const slackCallCompleted = events.find(
      (event) =>
        event.type === "events.iterate.com/codemode/function-call-completed" &&
        (event.payload as { path?: unknown }).path instanceof Array &&
        (event.payload as { path: string[] }).path.join(".") === "slack.chat.postMessage",
    );
    if (!slackCallCompleted) {
      throw new Error("Expected codemode/function-call-completed for slack.chat.postMessage.");
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/codemode/tool-provider-registered",
        payload: expect.objectContaining({
          path: ["slack"],
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/agent/input-added",
        payload: expect.objectContaining({
          content: expect.stringContaining("ctx.slack.chat.postMessage"),
        }),
      }),
    );
    expect(
      new Date(scriptRequested.createdAt).getTime() - new Date(output.createdAt).getTime(),
    ).toBeLessThan(1_000);
    expect(maxGapAfter(events, output.offset)).toBeLessThan(3_000);
    expect(slackCallCompleted).toMatchObject({
      payload: expect.objectContaining({
        outcome: expect.objectContaining({
          status: "returned",
          value: expect.objectContaining({
            channel: slackChannelId,
            ok: true,
          }),
        }),
      }),
    });
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
    const { baseUrl, client, project } = fixture;
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
        event.type === "events.iterate.com/codemode/function-call-completed" &&
        (event.payload as { path?: unknown }).path instanceof Array &&
        (event.payload as { path: string[] }).path.join(".") === "slack.chat.postMessage",
    });
    const slackCallCompleted = requiredPathEvent(
      events,
      "events.iterate.com/codemode/function-call-completed",
      "slack.chat.postMessage",
    );

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
              transformInput: { shallowMerge: { processorName: "agent-host" } },
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
        type: "events.iterate.com/codemode/tool-provider-registered",
        payload: expect.objectContaining({
          path: ["slack", "agent"],
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
    expect(
      events.filter((event) => event.type.startsWith("events.iterate.com/agent-chat/")),
    ).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/codemode/script-execution-requested",
        payload: expect.objectContaining({
          code: expect.stringContaining("ctx.slack.chat.postMessage"),
        }),
      }),
    );
    expect(slackCallCompleted).toMatchObject({
      payload: expect.objectContaining({
        outcome: expect.objectContaining({
          status: "returned",
          value: expect.objectContaining({
            channel: slackChannelId,
            ok: true,
          }),
        }),
      }),
    });

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
        event.type === "events.iterate.com/codemode/function-call-completed" &&
        (event.payload as { path?: unknown }).path instanceof Array &&
        (event.payload as { path: string[] }).path.join(".") === "slack.chat.postMessage",
    });
    expect(debugEvents).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/codemode/script-execution-requested",
        payload: expect.objectContaining({
          code: expect.stringContaining("const debug = await ctx.debug();"),
        }),
      }),
    );
    expect(debugEvents).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/codemode/function-call-completed",
        payload: expect.objectContaining({
          path: ["debug"],
          outcome: expect.objectContaining({ status: "returned" }),
        }),
      }),
    );
    expect(debugEvents).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/codemode/function-call-completed",
        payload: expect.objectContaining({
          path: ["slack", "chat", "postMessage"],
          outcome: expect.objectContaining({ status: "returned" }),
        }),
      }),
    );
    const debugSlackCallCompleted = requiredPathEvent(
      debugEvents,
      "events.iterate.com/codemode/function-call-completed",
      "slack.chat.postMessage",
    );
    const expectedStreamUrl = `${baseUrl}/projects/${encodeURIComponent(project.slug)}/streams/${routedAgentPath
      .replace(/^\/+/, "")
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    const debugSlackPayload = JSON.stringify(debugSlackCallCompleted.payload);
    expect(debugSlackPayload).toContain(expectedStreamUrl);
    expect(debugSlackPayload).not.toContain("events.iterate.com");
    expect(
      debugEvents.filter((event) => event.type.startsWith("events.iterate.com/agent-chat/")),
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

test("completes slack-agent event-mode codemode calls without blocking the stream callable queue", async () => {
  await using fixture = await createTestProjectFixture({ slugPrefix: "slack-agent-thread-info" });
  const { client, project } = fixture;
  const suffix = uniqueSuffix();
  const slackChannelId = `C_E2E_${suffix.replace(/[^a-zA-Z0-9]/g, "").slice(-12)}`;
  const rootMessageTs = `${Date.now()}.123456`;
  const routedAgentPath = slackAgentPath({
    channel: slackChannelId,
    threadTs: rootMessageTs,
  });
  const proofType = "events.iterate.com/slack-agent/e2e-thread-info-proof";

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
      idempotencyKey: `slack-agent-e2e-thread-info-route-webhook:${suffix}`,
      payload: {
        slackTeamId: "T_E2E",
        body: {
          type: "event_callback",
          team_id: "T_E2E",
          event_id: `EvThreadInfo${suffix}`,
          event: {
            type: "message",
            subtype: "bot_message",
            bot_id: "B_E2E",
            channel: slackChannelId,
            channel_type: "channel",
            ts: rootMessageTs,
            event_ts: rootMessageTs,
            text: "synthetic route initializer",
          },
        },
      },
    },
  });

  await readUntil({
    agentPath: routedAgentPath,
    client,
    projectId: project.id,
    afterOffset: "start",
    predicate: (event) =>
      event.type === "events.iterate.com/codemode/tool-provider-registered" &&
      (event.payload as { path?: unknown }).path instanceof Array &&
      (event.payload as { path: string[] }).path.join(".") === "slack.agent",
  });

  const started = await client.project.codemode.executeScript({
    code: `async (ctx) => {
  const thread = await ctx.slack.agent.threadInfo();
  await ctx.streams.append({
    event: {
      type: ${JSON.stringify(proofType)},
      payload: thread
    }
  });
}`,
    projectSlugOrId: project.id,
    streamPath: routedAgentPath,
    providers: [],
  });
  const scriptExecutionId = (started.event.payload as { scriptExecutionId: string })
    .scriptExecutionId;

  /**
   * Regression coverage for a stream alarm deadlock:
   *
   * codemode/script-execution-requested is delivered to CODEMODE_SESSION by the
   * stream callable-subscriber alarm. The script then appends
   * codemode/function-call-requested and waits for SLACK_AGENT to answer it.
   * If the alarm waits for the codemode RPC before delivering later queued
   * callable events, SLACK_AGENT never sees the function call and this proof
   * event is never appended.
   */
  const events = await readUntil({
    agentPath: routedAgentPath,
    client,
    projectId: project.id,
    afterOffset: started.event.offset - 1,
    predicate: (event) =>
      event.type === "events.iterate.com/codemode/script-execution-completed" &&
      (event.payload as { scriptExecutionId?: unknown }).scriptExecutionId === scriptExecutionId,
  });

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/codemode/function-call-requested",
      payload: expect.objectContaining({
        path: ["slack", "agent", "threadInfo"],
        providerPath: ["slack", "agent"],
        scriptExecutionId,
      }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/codemode/function-call-completed",
      payload: expect.objectContaining({
        path: ["slack", "agent", "threadInfo"],
        scriptExecutionId,
        outcome: expect.objectContaining({
          status: "returned",
          value: expect.objectContaining({
            channel: slackChannelId,
            thread_ts: rootMessageTs,
            streamPath: routedAgentPath,
          }),
        }),
      }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/codemode/script-execution-completed",
      payload: expect.objectContaining({
        scriptExecutionId,
        outcome: expect.objectContaining({ status: "returned" }),
      }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: proofType,
      payload: {
        channel: slackChannelId,
        thread_ts: rootMessageTs,
        streamPath: routedAgentPath,
      },
    }),
  );
  expect(events.filter((event) => event.type === "events.iterate.com/core/error-occurred")).toEqual(
    [],
  );
});

test("does not append normal out-of-order reducer errors during an agent codemode turn", async () => {
  await using fixture = await createTestProjectFixture({ slugPrefix: "agent-ordering" });
  const { client, project } = fixture;
  const suffix = uniqueSuffix();
  const agentPath = `/agents/ordering-${suffix}`;
  const message = `agent ordering proof ${suffix}`;

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
        content: `\`\`\`js
async (ctx) => {
  await ctx.chat.sendMessage({ message: ${JSON.stringify(message)} });
}
\`\`\``,
      },
    },
  });

  const events = await readUntil({
    agentPath,
    client,
    projectId: project.id,
    afterOffset: output.event.offset - 1,
    predicate: (event) => event.type === "events.iterate.com/codemode/script-execution-completed",
  });
  await delay(1_000);
  const settled = await client.project.streams.read({
    afterOffset: output.event.offset - 1,
    projectSlugOrId: project.id,
    streamPath: agentPath,
  });
  const processorErrors = settled.events.filter(
    (event) => event.type === "events.iterate.com/core/error-occurred",
  );

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/codemode/function-call-requested",
      payload: expect.objectContaining({
        path: ["chat", "sendMessage"],
      }),
    }),
  );
  expect(processorErrors).toEqual([]);
});

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

function eventPath(event: Event) {
  const payload = event.payload;
  if (payload == null || typeof payload !== "object" || !("path" in payload)) return [];
  const path = payload.path;
  return path instanceof Array && path.every((item) => typeof item === "string") ? path : [];
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

function requiredPathEvent(events: readonly Event[], type: string, path: string) {
  const event = events.find((item) => item.type === type && eventPath(item).join(".") === path);
  if (!event) throw new Error(`Expected ${type} for ${path}.`);
  return event;
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
