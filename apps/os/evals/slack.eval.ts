import { createHash } from "crypto";
import * as R from "remeda";
import { expect, beforeAll, vi } from "vitest";
import { evalite } from "evalite";
import { createTRPCClient, httpLink } from "@trpc/client";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import * as autoevals from "autoevals";
import OpenAI from "openai";
import dedent from "dedent";
import { z } from "zod";
import type { AppRouter } from "../backend/trpc/root.ts";
import type { AgentCoreEvent } from "../backend/agent/agent-core-schemas.ts";
import type { MCPEvent } from "../backend/agent/mcp/mcp-slice.ts";
import { type SlackSliceEvent } from "../backend/agent/slack-slice.ts";
import type { SlackWebhookPayload } from "../backend/agent/slack.types.ts";
import { zodTextFormat } from "./zod-openai.ts";

type AgentEvent = AgentCoreEvent | MCPEvent | SlackSliceEvent;

const baseURL = import.meta.env.VITE_PUBLIC_URL!;
const authClient = createAuthClient({
  baseURL: `${baseURL}/api/auth`,
  plugins: [adminClient()],
});

let trpcClient!: Awaited<ReturnType<typeof getAuthedTrpcClient>>;

beforeAll(async () => {
  trpcClient = await getAuthedTrpcClient();
});

evalite("greets user", {
  data: async () => {
    return [
      { input: "hi", expected: "hi! how can i help you today?" }, //
    ];
  },
  task: async (input) => {
    const h = await createTestHelper(trpcClient, testAgentName(input));
    const userGreeting = await h.sendUserMessage(input);
    return userGreeting.waitForReply();
  },
  scorers: [
    autoevals.Factuality, //
    autoevals.Moderation,
  ],
});

const ScoreResult = z.object({
  score: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "A score between 0 and 100. Give 0 for a total failure and 100 for a perfect score. If you think a reasonable person could reasonably take the same meaning from the response, give a score of 80+.",
    ),
  reason: z.string().describe("A detailed explanation of why you gave this score."),
});
evalite("multi-turn", {
  data: async () => {
    return [
      {
        input: {
          slug: "fruit-naming",
          messages: [
            { message: "name a green fruit", expected: "a green fruit" },
            { message: "name another", expected: "a green fruit, not the same as the first" },
            { message: "name another", expected: "a green fruit, not the same as the 1st or 2nd" },
          ],
        },
      },
    ];
  },
  task: async (input) => {
    const h = await createTestHelper(trpcClient, input.slug);

    for (const message of input.messages) {
      const userMessage = await h.sendUserMessage(message.message);
      const reply = await userMessage.waitForReply();

      await h.scoreLatest([`user: ${message.message}`, `assistant: ${reply}`], message.expected);
    }
    return { scores: h.scores, scorers: h.scorers };
  },
  scorers: [multiTurnScorer.mean(), multiTurnScorer.median(), multiTurnScorer.min()],
});

type ResponsesCreateParams = Parameters<OpenAI["responses"]["create"]>[0];
const multiTurnScorerParamsDefaults = {
  model: "gpt-5",
  instructions: `You are an eval assistant. Your job is to check if the last response matches the expectation. Respond with a score between 0 and 100.`,
  text: {
    format: zodTextFormat(ScoreResult, "ScoreResult"),
  },
} satisfies Omit<ResponsesCreateParams, "input">;
type MultiTurnScorerParams = Omit<ResponsesCreateParams, "input" | "text">;

function _multiTurnScorer(params: MultiTurnScorerParams = {}) {
  const scores: { reason: string; score: number }[] = [];

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const conversation: string[] = [];

  const scoreLatest = async (newMessages: string[], expectation: string) => {
    conversation.push(...newMessages);
    const input = dedent`
      <conversation>
      ${conversation.join("\n")}
      </conversation>

      <expectation>
      ${expectation}
      </expectation>
    `;

    const openaResponse = await openai.responses.parse({
      ...multiTurnScorerParamsDefaults,
      ...params,
      input,
    });
    if (!openaResponse.output_parsed) {
      throw new Error(`Didn't get a valid output for input:\n${input}`);
    }
    scores.push(openaResponse.output_parsed);
  };

  const addScore = async (conversation: string[], expectation: string) => {
    const input = dedent`
      ${conversation.join("\n")}

      expectation: ${expectation}
    `;
    const openaResponse = await openai.responses.parse({
      ...multiTurnScorerParamsDefaults,
      ...params,
      input,
    });
    if (!openaResponse.output_parsed) {
      throw new Error(`Didn't get a valid output for input:\n${input}`);
    }
    scores.push(openaResponse.output_parsed);
  };

  return {
    addScore,
    scores: scores,
    scorers: {
      mean: () => ({
        score: 0.01 * (R.meanBy(scores, (s) => s.score) ?? 0),
        metadata: { allScores: scores },
      }),
      median: () => ({
        score:
          0.01 *
          R.pipe(
            scores,
            R.sortBy((s) => s.score),
            R.filter((_, i, { length }) => Math.abs(length / 2 - i) < 1), // either one or two middle items
            R.meanBy((s) => s.score),
          ),
        metadata: { allScores: scores },
      }),
      min: () => ({
        score: 0.01 * (R.firstBy(scores, (s) => s.score)?.score ?? 0),
        metadata: { allScores: scores },
      }),
    },
    scoreLatest,
    conversation,
  };
}

type MultiTurnScorer = ReturnType<typeof _multiTurnScorer>;
function getScorer<T extends keyof MultiTurnScorer["scorers"]>(name: T) {
  return {
    name,
    scorer: (result: { output: { scorers: MultiTurnScorer["scorers"] } }) =>
      result.output.scorers[name](),
  };
}

const multiTurnScorer = Object.assign(_multiTurnScorer, {
  mean: () => getScorer("mean"),
  median: () => getScorer("median"),
  min: () => getScorer("min"),
});

// function mscorers() {
//   return { mean: getScorer("mean"), median: getScorer("median"), min: getScorer("min") };
// }

/** Gets an agent name based on the currently running test name and some (text) input */
function testAgentName(input: string) {
  const testName = expect.getState().currentTestName!.split(" > ").slice(0, -1).join(" > "); // evalite duplicates the test name, so remove the last breadcrumb thing
  const suffix = `${input.split(" ")[0].replaceAll(/\W/g, "").slice(0, 6)}-${createHash("md5").update(input).digest("hex").slice(0, 6)}`;
  return `mock_slack ${testName} | ${suffix} | ${Date.now()}`;
}

async function getAuthedTrpcClient() {
  const unauthedTrpc = createTRPCClient<AppRouter>({
    links: [httpLink({ url: `${baseURL}/api/trpc` })],
  });
  await unauthedTrpc.testing.createAdminUser.mutate({});
  let cookie = "";
  await authClient.signIn.email(
    { email: "admin@example.com", password: "password" },
    {
      onResponse({ response }) {
        cookie = response.headers.getSetCookie().join("; ");
      },
    },
  );
  return createTRPCClient<AppRouter>({
    links: [httpLink({ url: `${baseURL}/api/trpc`, headers: { cookie } })],
  });
}

async function createTestHelper(
  trpcClient: Awaited<ReturnType<typeof getAuthedTrpcClient>>,
  input: string,
  { logger = console as Pick<Console, "info" | "error"> } = {},
) {
  const agentName = testAgentName(input);
  const estates = await trpcClient.estates.list.query();
  const estateId = estates[0].id;
  expect(estateId).toBeTruthy();
  expect(agentName).toBeTruthy();

  const channel = "C0123456789";
  const threadTs = Date.now().toString();

  const fakeSlackUsers = {} as Record<string, { name: string; id: string }>;
  fakeSlackUsers["UALICE"] = { name: "Alice", id: "UALICE" };
  fakeSlackUsers["UBOB"] = { name: "Bob", id: "UBOB" };

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
      agentInstanceName: agentName,
      agentClassName: "SlackAgent",
      estateId,
      events: events as unknown as Parameters<
        typeof trpcClient.agents.addEvents.mutate
      >[0]["events"],
    });
  }
  const getEvents = async () => {
    const events = await trpcClient.agents.getEvents.query({
      estateId,
      agentInstanceName: agentName,
      agentClassName: "SlackAgent",
    });
    // @ts-ignore - excessively deep type
    return events as AgentEvent[]; // cast because the inferred type is so complex it frequently hits "type instantiation is excessively deep and possibly infinite"
  };
  const getState = async () => {
    return trpcClient.agents.getState.query({
      estateId,
      agentInstanceName: agentName,
      agentClassName: "SlackAgent",
    });
  };
  type WaitUntilOptions = Exclude<Parameters<typeof vi.waitUntil>[1], number>;
  type WaitForEvent = {
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
        const events: AgentCoreEvent[] = (await getEvents()) as never;
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
      user: fakeSlackUsers["UALICE"].id,
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
    const added = await addEvents([
      {
        type: "SLACK:WEBHOOK_EVENT_RECEIVED",
        data: {
          payload: { event: override(buildSlackMessageEvent(message)) },
        },
        triggerLLMRequest: true,
      },
    ]);

    const waitForReply = async () => {
      const reply = await waitForEvent("CORE:LOCAL_FUNCTION_TOOL_CALL", added, {
        select: (e) => {
          if (e.data.call.status !== "completed" || e.data.call.name !== "sendSlackMessage") return;
          const { text, endTurn } = JSON.parse(e.data.call.arguments) as {
            text: string;
            endTurn?: boolean;
          };
          return endTurn ? text : undefined;
        },
      });
      logger.info(`[${agentName}] Received reply: ${reply}`);
      return reply;
    };
    return { waitForReply };
  };

  return {
    estateId,
    addEvents,
    getEvents,
    getState,
    waitForEvent: waitForEvent as WaitForEvent,
    sendUserMessage,
    ...multiTurnScorer(),
  };
}
