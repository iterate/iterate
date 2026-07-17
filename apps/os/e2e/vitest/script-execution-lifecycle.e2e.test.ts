import { test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";
import { itxScript } from "../test-support/itx-script-builder.ts";

const SCRIPT_STARTED = "events.iterate.com/test/script-execution-started";

test(
  "runScript observes completion after its stream Durable Object restarts",
  { timeout: 30_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "script-lifecycle" });
    using executionItx = handle.itx();
    using controlItx = handle.itx();

    const marker = crypto.randomUUID();
    const stream = controlItx.streams.get("/");
    const execution = itxScript(executionItx.capabilityHost)
      .vars({ marker })
      .execute(async (itx, vars) => {
        await itx.streams.get("/").append({
          type: "events.iterate.com/test/script-execution-started",
          payload: { marker: vars.marker },
        });
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        return { marker: vars.marker };
      });

    await stream.waitForEvent({
      eventTypes: [SCRIPT_STARTED],
      predicate: (event) =>
        event.payload !== null &&
        typeof event.payload === "object" &&
        !Array.isArray(event.payload) &&
        event.payload.marker === marker,
      timeoutMs: 10_000,
    });

    // The public runScript call is already waiting for its settlement. Kill
    // that Stream DO incarnation while the Dynamic Worker remains in flight;
    // the Worker-owned observer must reopen a bounded lease and replay the
    // durable completion from the request offset.
    await stream.kill().catch(() => undefined);

    expect((await execution).success()).toEqual({ marker });
  },
);
