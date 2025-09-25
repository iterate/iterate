import { createHash, randomUUID } from "crypto";
import { expect, beforeAll, vi } from "vitest";
import { evalite } from "evalite";
import { createTRPCClient, httpLink } from "@trpc/client";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import * as autoevals from "autoevals";
import type { AppRouter } from "../backend/trpc/root.ts";
import type { AgentCoreEvent } from "../backend/agent/agent-core-schemas.ts";
import type { MCPEvent } from "../backend/agent/mcp/mcp-slice.ts";
import {
  SlackWebhookEventReceived,
  SlackWebhookEventReceivedInput,
  type SlackSliceEvent,
} from "../backend/agent/slack-slice.ts";
import type { SlackWebhookPayload } from "../backend/agent/slack.types.ts";

type AgentEvent = AgentCoreEvent | MCPEvent | SlackSliceEvent;

const baseURL = import.meta.env.VITE_PUBLIC_URL!;
export const authClient = createAuthClient({
  baseURL: `${baseURL}/api/auth`,
  plugins: [adminClient()],
});

const serviceAuthToken = process.env.SERVICE_AUTH_TOKEN;
if (!serviceAuthToken) {
  throw new Error("SERVICE_AUTH_TOKEN environment variable is required");
}

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

/** Gets an agent name based on the currently running test name and some (text) input */
function testAgentName(input: string) {
  const testName = expect.getState().currentTestName!.split(" > ").slice(0, -1).join(" > "); // evalite duplicates the test name, so remove the last breadcrumb thing
  const suffix = `${input.split(" ")[0].replaceAll(/\W/g, "").slice(0, 6)}-${createHash("md5").update(input).digest("hex").slice(0, 6)}`;
  return `${testName} | ${suffix} | ${randomUUID()}`;
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
) {
  const agentName = testAgentName(input);
  const estates = await trpcClient.estates.list.query();
  const estateId = estates[0].id;
  expect(estateId).toBeTruthy();
  expect(agentName).toBeTruthy();

  const addEvents = async (
    events: Omit<AgentEvent, "createdAt" | "eventIndex" | "metadata" | "eventIndex">[],
  ) => {
    return trpcClient.agents.addEvents.mutate({
      agentInstanceName: agentName,
      agentClassName: "SlackAgent",
      estateId,
      events: events as unknown as Parameters<
        typeof trpcClient.agents.addEvents.mutate
      >[0]["events"],
    });
  };
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

  const fakeSlackUsers = {} as Record<string, { name: string; id: string }>;
  fakeSlackUsers["UALICE"] = { name: "Alice", id: "UALICE" };
  fakeSlackUsers["UBOB"] = { name: "Bob", id: "UBOB" };

  const threadTs = Date.now().toString();

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
    const added = await addEvents([
      await SlackWebhookEventReceived.parseAsync({
        type: "SLACK:WEBHOOK_EVENT_RECEIVED",
        data: {
          payload: { event: override(buildSlackMessageEvent(message)) },
        },
        triggerLLMRequest: true,
        createdAt: new Date().toISOString(),
        eventIndex: 0,
        metadata: {},
      } satisfies SlackWebhookEventReceived).catch((e) => {
        console.error({ e });
        throw e;
      }),
    ]);

    const waitForReply = async () => {
      return waitForEvent("CORE:LLM_OUTPUT_ITEM", added, {
        select: (e) =>
          e.data.type === "message" &&
          e.data.content[0].type === "output_text" &&
          e.data.content[0].text,
      });
    };
    return { waitForReply };
  };

  // const sendUserMessage = async (message: string) => {
  //   const added = await addEvents([
  //     {
  //       type: "CORE:LLM_INPUT_ITEM",
  //       data: { type: "message", role: "user", content: [{ type: "input_text", text: message }] },
  //       triggerLLMRequest: true,
  //     },
  //   ]);

  //   const waitForReply = async () => {
  //     return waitForEvent("CORE:LLM_OUTPUT_ITEM", added, {
  //       select: (e) =>
  //         e.data.type === "message" &&
  //         e.data.content[0].type === "output_text" &&
  //         e.data.content[0].text,
  //     });
  //   };
  //   return { waitForReply };
  // };

  return {
    estateId,
    addEvents,
    getEvents,
    getState,
    waitForEvent: waitForEvent as WaitForEvent,
    sendUserMessage,
    // console.log,
  };
}
