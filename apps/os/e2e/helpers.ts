import { createHmac } from "node:crypto";
import { inspect } from "util";
import { z } from "zod";
import { expect, inject, vi } from "vitest";
import { createTRPCClient, httpLink } from "@trpc/client";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import type { StandardSchemaV1 } from "better-auth"; // standard schema v1 can come from anywhere really but better-auth is kind enough to export it
import { init, type Span } from "braintrust";
import { evalite } from "evalite";
import type { Evalite } from "evalite/types";
import { match, P } from "ts-pattern";
import type { AppRouter } from "../backend/trpc/root.ts";
import type { AgentCoreEvent } from "../backend/agent/agent-core-schemas.ts";
import type { MCPEvent } from "../backend/agent/mcp/mcp-slice.ts";
import { type SlackSliceEvent } from "../backend/agent/slack-slice.ts";
import type { SlackWebhookPayload } from "../backend/agent/slack.types.ts";
import type { ToolSpec } from "../backend/agent/tool-schemas.ts";
import type { ExplainedScoreResult } from "../evals/scorer.ts";

// TODO: duplicated here because there's some weird circular dependency issue with the slack utils in tests
function getRoutingKey({ estateId, threadTs }: { estateId: string; threadTs: string }) {
  const suffix = `slack-${estateId}`;
  return `ts-${threadTs}-${suffix}`;
}

export * from "../evals/scorer.ts";

export type AgentEvent = (AgentCoreEvent | MCPEvent | SlackSliceEvent) & {
  eventIndex: number;
  createdAt: string;
};

export const baseURL = import.meta.env.VITE_PUBLIC_URL!;
export const authClient = createAuthClient({
  baseURL: `${baseURL}/api/auth`,
  plugins: [adminClient()],
});

export async function getAuthedTrpcClient() {
  const { sessionCookies } = await getServiceAuthCredentials();
  const client = createTRPCClient<AppRouter>({
    links: [httpLink({ url: `${baseURL}/api/trpc`, headers: { cookie: sessionCookies } })],
  });
  const impersonate = (userId: string) => {
    return getImpersonatedTrpcClient({ userId, adminSessionCookes: sessionCookies });
  };
  return { client, sessionCookies, impersonate };
}

const E2EEnv = z.object({
  SERVICE_AUTH_TOKEN: z.string(),
});
export const getServiceAuthCredentials = async () => {
  const env = E2EEnv.parse(process.env);
  const serviceAuthResponse = await fetch(`${baseURL}/api/auth/service-auth/create-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serviceAuthToken: env.SERVICE_AUTH_TOKEN }),
  });

  if (!serviceAuthResponse.ok) {
    const error = await serviceAuthResponse.text();
    const headers = inspect(serviceAuthResponse.headers);
    throw new Error(
      `Failed to authenticate with service auth: ${error}. Status ${serviceAuthResponse.status}. Headers: ${headers}`,
    );
  }

  const sessionCookies = serviceAuthResponse.headers.get("set-cookie");
  if (!sessionCookies) {
    const text = await serviceAuthResponse.text();
    const headers = inspect(serviceAuthResponse.headers);
    throw new Error(
      `Failed to get session cookies from service auth. Response: ${text}. Status ${serviceAuthResponse.status}. Headers: ${headers}`,
    );
  }

  return { sessionCookies };
};

export const getImpersonatedTrpcClient = async (params: {
  userId: string;
  adminSessionCookes: string;
}) => {
  let impersonationCookies = "";

  const impersonationResult = await authClient.admin.impersonateUser(
    { userId: params.userId },
    {
      // Something changed in better-auth, so now we need to manually set the Origin header
      // most likely because we are calling this api from server-side which doesn't add the header
      // but better-auth expects it to be set
      headers: { cookie: params.adminSessionCookes, origin: baseURL },
      onResponse(context: { response: Response }) {
        const cookies = context.response.headers.getSetCookie();
        const cookieObj = Object.fromEntries(cookies.map((cookie) => cookie.split("=")));
        if (cookieObj) {
          impersonationCookies = Object.entries(cookieObj)
            .map(([key, value]) => `${key}=${value}`)
            .join("; ");
        }
      },
    },
  );

  if (!impersonationResult?.data) {
    throw new Error("Failed to impersonate user", { cause: impersonationResult });
  }

  if (!impersonationCookies) {
    throw new Error("Failed to get impersonation cookies", { cause: impersonationResult });
  }

  const trpcClient = createTRPCClient<AppRouter>({
    links: [httpLink({ url: `${baseURL}/api/trpc`, headers: { cookie: impersonationCookies } })],
  });

  return { trpcClient, impersonationCookies };
};

export async function createTestHelper({
  trpcClient,
  inputSlug,
  braintrustSpanExportedId,
  logger = console,
  /** The user ID to link Slack users to. If provided, fake Slack users will be linked to this user. */
  userId,
}: {
  trpcClient: Awaited<ReturnType<typeof getAuthedTrpcClient>>["client"];
  inputSlug: string;
  braintrustSpanExportedId?: string;
  logger?: Pick<Console, "info" | "error">;
  /** The user ID to link Slack users to. If provided, fake Slack users will be linked to this user. */
  userId?: string;
}) {
  const { client: adminTrpcClient } = await getAuthedTrpcClient();

  // Get estateId first since we need it for the routing key
  const estates = await trpcClient.estates.list.query();
  const estateId = estates[0].id;
  expect(estateId).toBeTruthy();

  // Create threadTs and channel before the routing key since the webhook handler
  // uses a LIKE query to find agents by threadTs and "-slack-" pattern
  const channel = "C0123456789";
  // TODO, we are using magical 4 digit timestamps for the test. This should be replaced with a mapping table.
  const threadTs = "0234";

  // Build a routing key that matches what the webhook handler expects:
  // - Must contain threadTs (for LIKE %{threadTs}% query)
  // - Must contain "-slack-" (for LIKE %-slack-% query)
  // - Add "test-" prefix so we can identify it came from a test

  const agentRoutingKey = getRoutingKey({ estateId, threadTs });
  expect(agentRoutingKey).toBeTruthy();

  const { info } = await trpcClient.agents.getOrCreateAgent.mutate({
    estateId,
    agentClassName: "SlackAgent",
    route: agentRoutingKey,
    reason: `Agent created for test ${expect.getState().currentTestName}`,
  });
  const agentName = info.durableObjectName;
  console.log("Got agent name", agentName);
  const agentProcedureProps = {
    agentInstanceName: agentName,
    agentClassName: "SlackAgent",
    estateId,
  } as const;

  await adminTrpcClient.testing.mockSlackAPI.mutate(agentProcedureProps);

  // Generate unique Slack user IDs per test run to avoid conflicts between tests
  // Format: TEST_{unique-suffix}_{name} to identify as test users
  // Use a combination of inputSlug and timestamp to ensure uniqueness across tests
  const uniqueSuffix = `${inputSlug.slice(0, 8)}_${Date.now().toString(36)}`;
  const fakeSlackUsers = {} as Record<string, { name: string; id: string }>;
  const aliceId = `TEST_${uniqueSuffix}_ALICE`;
  const bobId = `TEST_${uniqueSuffix}_BOB`;
  fakeSlackUsers[aliceId] = { name: "Alice", id: aliceId };
  fakeSlackUsers[bobId] = { name: "Bob", id: bobId };

  // Add fake slack users to the estate database so they can be looked up
  const fakeMembers = Object.values(fakeSlackUsers).map((user) => ({
    id: user.id,
    name: user.name,
    real_name: user.name,
    is_bot: false,
    profile: {
      email: `${user.id.toLowerCase()}@test.iterate.com`,
    },
  }));

  const teamId = "TEST_TEAM";
  await adminTrpcClient.testing.addSlackUsersToEstate.mutate({
    estateId,
    members: fakeMembers,
    // Link the fake Slack users to the test user if userId is provided
    ...(userId && { linkToUserId: userId }),
  });
  await adminTrpcClient.testing.setupTeamId.mutate({
    estateId,
    teamId,
  });

  if (braintrustSpanExportedId)
    await trpcClient.agents.setBraintrustParentSpanExportedId.mutate({
      ...agentProcedureProps,
      braintrustParentSpanExportedId: braintrustSpanExportedId,
    });

  // initialise slack state - right now we require channel and thread to be set independently of the webhook
  // (although this is in the onWebhookReceived method, we don't actually call that in the eval, we create events directly)
  await addEvents([
    {
      type: "SLACK:UPDATE_SLICE_STATE",
      data: { slackChannelId: channel, slackThreadId: threadTs },
      triggerLLMRequest: false,
    },
  ]);

  async function addEvents(
    events: Omit<AgentEvent, "createdAt" | "eventIndex" | "metadata" | "eventIndex">[],
  ) {
    return trpcClient.agents.addEvents.mutate({
      ...agentProcedureProps,
      events: events as unknown as Parameters<
        typeof trpcClient.agents.addEvents.mutate
      >[0]["events"],
    });
  }

  async function addToolSpec(...toolSpecs: ToolSpec[]) {
    const ruleKey = `eval-dynamically-added-tools-${Date.now()}${Math.random()}`.replace("0.", ".");
    return addEvents([
      {
        type: "CORE:ADD_CONTEXT_RULES",
        data: { rules: [{ key: ruleKey, tools: toolSpecs }] },
        triggerLLMRequest: false,
      },
    ]);
  }

  const getEvents = async () => {
    const events = await trpcClient.agents.getEvents.query(agentProcedureProps);
    // @ts-ignore - excessively deep type
    return events as AgentEvent[]; // cast because the inferred type is so complex it frequently hits "type instantiation is excessively deep and possibly infinite"
  };
  const _getState = async () => {
    return trpcClient.agents.getState.query({
      estateId,
      agentInstanceName: agentName,
      agentClassName: "SlackAgent",
    });
  };

  const waitForEvent: WaitForEvent = <T extends AgentEvent["type"], Selection>(
    type: T,
    since: { eventIndex: number }[],
    options?: WaitUntilOptions & {
      select?: (e: Extract<AgentEvent, { type: T }>) => Selection | null | undefined | false | 0;
    },
  ) => {
    const lastKnownEventIndex = since.at(-1)!.eventIndex;
    return vi.waitUntil(
      async () => {
        const events: AgentEvent[] = (await getEvents()) as never;
        const select = options?.select || ((e) => e);
        for (const event of events) {
          if (event.type !== type) continue;
          if (event.eventIndex <= lastKnownEventIndex) continue;
          const selection = select(event as Extract<AgentEvent, { type: T }>);
          if (selection) return selection;
        }
        return null;
      },
      { timeout: 20_000, interval: 1000, ...options },
    );
  };

  const buildSlackMessageEvent = (message: string) => {
    const ts = Date.now().toString();
    return {
      type: "message",
      text: message,
      channel: "DEADBEEF",
      subtype: undefined,
      user: fakeSlackUsers[aliceId].id,
      thread_ts: threadTs,
      ts: ts,
      event_ts: ts,
      channel_type: null as never,
    } satisfies SlackWebhookPayload["event"];
  };
  type MessageEvent = ReturnType<typeof buildSlackMessageEvent>;

  const sendUserMessage = async (
    message: string,
    override: (event: MessageEvent) => MessageEvent = (ev) => ev,
  ) => {
    logger.info(`[${agentName}] Sending user message: ${message}`);

    // Call the webhook handler directly
    const event = override(buildSlackMessageEvent(message));
    const rawBody = JSON.stringify({
      event,
      team_id: teamId,
      authorizations: [{ is_bot: true, user_id: "UBOT" }],
    } satisfies SlackWebhookPayload);
    const signingSecret = process.env?.SLACK_SIGNING_SECRET;

    if (!signingSecret) {
      throw new Error("SLACK_SIGNING_SECRET not configured");
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const sigBaseString = `v0:${timestamp}:${rawBody}`;
    const hmac = createHmac("sha256", signingSecret);

    hmac.update(sigBaseString);
    const signature = `v0=${hmac.digest("hex")}`;

    await fetch(`${baseURL}/api/integrations/slack/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp.toString(),
      },
      body: rawBody,
    });

    const eventsAtSend = await getEvents();

    const waitForReply = async (options?: WaitUntilOptions) => {
      const reply = await waitForEvent("CORE:LOCAL_FUNCTION_TOOL_CALL", eventsAtSend, {
        select: (e) => {
          if (e.data.call.status !== "completed" || e.data.call.name !== "sendSlackMessage") return;
          const { text, endTurn } = JSON.parse(e.data.call.arguments) as {
            text: string;
            endTurn?: boolean;
          };
          return endTurn ? text : undefined;
        },
        ...(options as {}),
      });
      logger.info(`[${agentName}] Received reply: ${reply}`);
      return reply;
    };

    return { events: eventsAtSend, waitForReply };
  };

  const waitForCompletedToolCall = async <T>(
    schema: StandardSchemaV1<unknown, T>,
    name: string,
    since: { eventIndex: number }[],
  ) => {
    const output = await waitForEvent("CORE:LOCAL_FUNCTION_TOOL_CALL", since, {
      select: (e) =>
        e.data.call.status === "completed" && e.data.call.name === name && e.data.result.success
          ? (e.data.result.output as T)
          : null,
    });
    const validated = await schema["~standard"].validate(output);
    if (validated.issues) {
      throw new Error(
        `Tool call ${name} was successful but result didn't match schema provided:\n${z.prettifyError(validated)}`,
        { cause: output },
      );
    }
    return validated.value;
  };

  const getAgentDebugURL = async () => {
    const result = await trpcClient.agents.getAgentDebugURL.query(agentProcedureProps);
    return result.debugURL;
  };

  return {
    estateId,
    addEvents,
    getEvents,
    // getState,
    waitForCompletedToolCall,
    waitForEvent: waitForEvent as WaitForEvent,
    sendUserMessage,
    getAgentDebugURL,
    addToolSpec,
    braintrustSpanExportedId,
  };
}
export type WaitUntilOptions = {
  interval?: number;
  timeout?: number;
};
export type WaitForEvent = {
  <T extends AgentEvent["type"]>(
    type: T,
    since: { eventIndex: number }[],
    options?: WaitUntilOptions,
  ): Promise<Extract<AgentEvent, { type: T }> | null>;
  <T extends AgentEvent["type"], Selection>(
    type: T,
    since: { eventIndex: number }[],
    options?: WaitUntilOptions & {
      /**
       * Optional mapper function. If it returns a truthy value, that value be returned instead of the event.
       * If it returns a falsy value, the event is not returned and we continue waiting.
       */
      select?: (e: Extract<AgentEvent, { type: T }>) => Selection | null | undefined | false | 0;
    },
  ): Promise<Selection>;
};

export type TrialOutput = { scores: ExplainedScoreResult[] };
export type MultiTrialScorerOutput = {
  trials: { trialIndex: number; trialName: string; result: TrialOutput }[];
};

/**
 * This function wraps evalite and adds braintrust logging:
 * - It saves us having to manually create braintrust spans and log scores
 * - It passes the span id to the task function, so we can inject it into the agent and get traces
 * - It is needed because we need to add the scores to the braintrust span, which is done outside of the task function
 * - When trialCount > 1, each input is run multiple times with individual trial spans under a parent input span
 */
export function evaliterate<TInput extends { slug: string }, TExpected>(
  name: string,
  opts: {
    data: () => Promise<{ input: TInput }[]>;
    task: (input: {
      input: TInput;
      braintrustSpanExportedId: string;
    }) => Promise<{ scores: ExplainedScoreResult[] }>;
    scorers: Evalite.ScorerOpts<TInput, MultiTrialScorerOutput, TExpected>[];
    columns?: Evalite.RunnerOpts<TInput, MultiTrialScorerOutput, TExpected>["columns"];
    trialCount?: number; // Number of times to run each input (default: 1)
  },
) {
  const experimentName = `${name}-${inject("vitestBatchId")}`;
  const hash = (data: unknown) =>
    match(data)
      .with({ slug: P.string }, (d) => d.slug)
      .otherwise(() => JSON.stringify(data)); // serializable test cases only, please

  const spanMap: Record<string, Span | undefined> = {};
  const resolvedTrialCount = opts.trialCount || 1;
  if (resolvedTrialCount !== 1) {
    console.log(
      `Running ${experimentName} ${resolvedTrialCount} times. Look in https://www.braintrust.dev/app/Nustom/p/${process.env.PROJECT_NAME}/experiments for results.`,
    );
  }

  const experiment = process.env.BRAINTRUST_API_KEY
    ? init(process.env.PROJECT_NAME!, {
        apiKey: process.env.BRAINTRUST_API_KEY,
        experiment: experimentName,
        metadata: {
          testName: name,
          experimentName,
          vitestBatchId: inject("vitestBatchId"),
          trialCount: resolvedTrialCount,
        },
      })
    : null;

  const braintrustScorerWrapper = <TOutput>(
    scorerOpts: Evalite.ScorerOpts<TInput, TOutput, TExpected>,
  ) => {
    const wrappedScorerFn: (
      result: Evalite.ScoreInput<TInput, TOutput, TExpected>,
    ) => Promise<Evalite.UserProvidedScoreWithMetadata> = async (result) => {
      const _score = await scorerOpts.scorer(result);
      const { score, metadata } = typeof _score === "number" ? { score: _score } : _score;

      const braintrustSpan = spanMap[hash(result.input)];
      braintrustSpan?.log({
        scores: { [String(scorerOpts.name)]: score },
        metadata: { [String(scorerOpts.name)]: metadata },
      });
      await braintrustSpan?.flush();

      return { score, metadata };
    };
    return {
      ...scorerOpts,
      scorer: wrappedScorerFn,
    } as typeof scorerOpts;
  };

  evalite<TInput, MultiTrialScorerOutput, TExpected>(experimentName, {
    data: opts.data,
    columns: opts.columns,
    task: async (input) => {
      const parentSpan = experiment?.startSpan({ name: `eval-${input.slug}`, type: "eval" });
      spanMap[hash(input)] = parentSpan;
      parentSpan?.log({ input });
      await parentSpan?.flush();

      const trials = await Promise.all(
        Array.from({ length: resolvedTrialCount }, async (_, trialIndex) => {
          const trialName = `trial_${trialIndex + 1}`;
          const trialSpan = parentSpan?.startSpan({ type: "task", name: trialName });
          trialSpan?.log({ input });
          await trialSpan?.flush();
          const braintrustSpanExportedId = await trialSpan?.export();

          const output = await opts.task({
            input: { ...input, slug: `${input.slug}-${trialName}` },
            braintrustSpanExportedId: braintrustSpanExportedId || "",
          });

          trialSpan?.log({ output });
          trialSpan?.end();
          await trialSpan?.flush();

          return { trialIndex, trialName, result: output };
        }),
      );

      parentSpan?.log({ output: trials });
      await parentSpan?.flush();

      return { trials };
    },
    scorers: opts.scorers.map(braintrustScorerWrapper),
  });
}

export const createDisposer = () => {
  const disposeFns: Array<() => Promise<void>> = [];
  return {
    fns: disposeFns,
    [Symbol.asyncDispose]: async () => {
      const errors: unknown[] = [];
      for (const fn of disposeFns.toReversed()) {
        await fn().catch((err) => errors.push(err));
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 0) throw new Error("Multiple disposers failed", { cause: errors });
    },
  };
};
