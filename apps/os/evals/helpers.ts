import { createHash } from "crypto";
import { expect, vi } from "vitest";
import { createTRPCClient, httpLink } from "@trpc/client";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import type { AppRouter } from "../backend/trpc/root.ts";
import type { AgentCoreEvent } from "../backend/agent/agent-core-schemas.ts";
import type { MCPEvent } from "../backend/agent/mcp/mcp-slice.ts";
import { type SlackSliceEvent } from "../backend/agent/slack-slice.ts";
import type { SlackWebhookPayload } from "../backend/agent/slack.types.ts";

export * from "./scorer.ts";

export type AgentEvent = AgentCoreEvent | MCPEvent | SlackSliceEvent;

export const baseURL = import.meta.env.VITE_PUBLIC_URL!;
export const authClient = createAuthClient({
  baseURL: `${baseURL}/api/auth`,
  plugins: [adminClient()],
});

/** Gets an agent name based on the currently running test name and some (text) input */
export function testAgentName(input: string) {
  const testName = expect.getState().currentTestName!.split(" > ").slice(0, -1).join(" > "); // evalite duplicates the test name, so remove the last breadcrumb thing
  const suffix = `${input.split(" ")[0].replaceAll(/\W/g, "").slice(0, 6)}-${createHash("md5").update(input).digest("hex").slice(0, 6)}`;
  return `mock_slack ${testName} | ${suffix} | ${Date.now()}`;
}

export async function getAuthedTrpcClient({
  email = "admin@example.com",
  password = "password",
} = {}) {
  const unauthedTrpc = createTRPCClient<AppRouter>({
    links: [httpLink({ url: `${baseURL}/api/trpc` })],
  });
  await unauthedTrpc.testing.createAdminUser.mutate({});
  let cookie = "";
  await authClient.signIn.email(
    { email, password },
    {
      onResponse({ response }) {
        cookie = response.headers.getSetCookie().join("; ");
      },
    },
  );
  if (!cookie) {
    throw new Error(`Failed to sign in as ${email}`);
  }

  return createTRPCClient<AppRouter>({
    links: [httpLink({ url: `${baseURL}/api/trpc`, headers: { cookie } })],
  });
}

export async function createTestHelper(
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
    // logger.info(`[${agentName}] Sending user message: ${message}`);
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
      // logger.info(`[${agentName}] Received reply: ${reply}`);
      return reply;
    };
    return { waitForReply };
  };

  return {
    estateId,
    addEvents,
    getEvents,
    // getState,
    waitForEvent: waitForEvent as WaitForEvent,
    sendUserMessage,
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
