import { describe, expect, it } from "vitest";
import { KEEPALIVE_ALARM_LEAD_MS, STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  MemoryStreamNetwork,
} from "iterate/processors/testing";
import { TelegramAgentProcessorContract } from "./telegram-agent-processor-contract.ts";
import { TelegramAgentProcessor } from "./telegram-agent-processor-implementation.ts";

const CONNECTION = "mishas-helper-bot";
const CHAT_ID = 42424242;
const HOME = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}`;

function makeHarness() {
  const clock = { now: Date.parse("2026-07-15T12:00:00Z") };
  const network = new MemoryStreamNetwork(() => clock.now);
  const send: { impl: (body: Record<string, unknown>) => Promise<{ messageId: number }> } = {
    impl: () => {
      throw new Error("must not send in this scenario");
    },
  };
  const harness = makeProcessorHarness<TelegramAgentProcessorContract, TelegramAgentProcessor>({
    substrate: {
      clock,
      stream: network.get(HOME),
      progress: makeMemoryProgressStore(),
    },
    createProcessor: (deps) =>
      new TelegramAgentProcessor({
        ...deps,
        sendTelegramMessage: ({ body }) => send.impl(body),
      }),
  });
  return { ...harness, network, send };
}

describe("eviction recovery end to end", () => {
  it("revives a send lost to eviction and re-runs its unacknowledged delivery exactly once", async () => {
    const h = makeHarness();
    const sends: unknown[] = [];
    h.send.impl = () => new Promise<never>(() => {});

    await h.play(
      [
        "append",
        {
          type: "events.iterate.com/telegram-agent/created",
          payload: { config: { chatId: String(CHAT_ID), connection: CONNECTION } },
        },
        {
          type: "events.iterate.com/telegram/send-requested",
          payload: { text: "The deploy is green." },
        },
      ],
      () => {
        expect(h.events("events.iterate.com/telegram/message-sent")).toHaveLength(0);
        h.send.impl = async (body) => {
          sends.push(body);
          return { messageId: 777 };
        };
      },
      ["crash"],
      () => expect(sends).toHaveLength(0),
      ["advanceTime", KEEPALIVE_ALARM_LEAD_MS + 1],
    );

    expect(h.events(STREAM_PROCESSOR_REVIVED_EVENT_TYPE)).toHaveLength(1);
    expect(h.events(STREAM_PROCESSOR_REVIVED_EVENT_TYPE)[0]?.payload).toMatchObject({
      processorSlug: TelegramAgentProcessorContract.slug,
      revivals: 1,
      version: "test-harness",
    });
    expect(sends).toEqual([
      expect.objectContaining({ chat_id: CHAT_ID, text: "The deploy is green." }),
    ]);
    expect(h.events("events.iterate.com/telegram/message-sent")[0]?.payload).toMatchObject({
      messageId: 777,
      requestOffset: 2,
    });
    expect(
      h.network.eventsAt(`/integrations/telegram/${CONNECTION}`).map((event) => event.type),
    ).toEqual(["events.iterate.com/telegram/message-sent"]);

    await h.settle();
    expect(sends).toHaveLength(1);
  });
});
