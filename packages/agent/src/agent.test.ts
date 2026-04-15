import { describe, expect, test } from "vitest";
import { processor } from "./agent.ts";
import { AgentInputEvent } from "./agent.ts";
import { useProcessorTestRig } from "./test-helpers.ts";

describe.skip("agent", () => {
  test("replays an assistant response from HAR", async () => {
    await using rig = await useProcessorTestRig({
      processors: [processor],
      replayHarPath: new URL("./fixtures/agent-send-message.har", import.meta.url),
    });

    await rig.append(
      AgentInputEvent.parse({
        type: "agent-input-added",
        payload: {
          role: "user",
          content:
            "Say hello to the user by returning exactly one ts block that calls ctx.sendMessage.",
        },
      }),
    );

    const assistantEvent = await rig.waitForEvent(
      (event) =>
        AgentInputEvent.safeParse(event).success &&
        AgentInputEvent.parse(event).payload.role === "assistant",
    );

    expect(assistantEvent).toMatchObject({
      type: "agent-input-added",
      payload: {
        role: "assistant",
      },
    });
    expect(AgentInputEvent.parse(assistantEvent).payload.content).toBe(
      ["```ts", 'ctx.sendMessage({ message: "Hello!" })', "```"].join("\n"),
    );
  }, 20_000);
});
