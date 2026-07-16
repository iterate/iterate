/**
 * Goal coverage: an agent uses itx tools. Deterministic version of the
 * Playwright chat spec — drive an agent over itx, instruct it to run a script
 * that appends a proof event, and assert the full codemode loop on the stream:
 * llm request → output → capability-host/script-run-requested/completed → proof
 * event on the target stream → visible web reply.
 */
import { test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";

const PROOF_STREAM = "/e2e/agent-tools-proof";
const PROOF_TYPE = "events.iterate.test/agent-tools-proof";

test(
  "agent runs an itx script that appends a proof event, then replies",
  // Full LLM codemode loop — heavy-test ceiling (E2E_HEAVY_TEST_TIMEOUT_MS);
  // a healthy run is well under a minute.
  { timeout: 240_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "agent-tools" });
    using agent = handle.agent("/agents/e2e-tools");
    await agent.create({});

    const marker = crypto.randomUUID().slice(0, 8);
    // Full codemode loop (LLM → script → reply) routinely exceeds the 45s ask
    // default under preview load; wait with the same ceiling as the test.
    await agent.ask({
      message: [
        `Run a script that appends one event of type ${PROOF_TYPE} with payload`,
        `{ "marker": "${marker}" } to the stream ${PROOF_STREAM} via`,
        `itx.streams.get(${JSON.stringify(PROOF_STREAM)}).append(...). After the script`,
        `runs, send a chat message that contains exactly the word done.`,
      ].join(" "),
      timeoutMs: 180_000,
    });

    // The reply may arrive before or after the script completes depending on
    // how the model ordered its actions — poll both effects independently.
    // (waitForCondition, not expect.poll: expect.poll loses the test context
    // on vitest retry in the CI-parallel lane and turns any first-attempt
    // flake into a hard "expect.poll() must be called inside a test" failure.)
    using itx = handle.itx();
    await waitForCondition(
      async () => {
        const events = await itx.streams.get(PROOF_STREAM).getEvents({});
        return events.some(
          (event) => event.type === PROOF_TYPE && event.payload?.marker === marker,
        );
      },
      {
        description: "the proof event to land on the target stream",
        intervalMs: 1_000,
        // Turns run 15-60s under preview-account load (measured live
        // 2026-07-10: a healthy turn with a 31s LLM response); two turns plus
        // boot must fit, so this sits just under the 240s test ceiling.
        timeoutMs: 180_000,
      },
    );

    const agentEvents = await agent.stream.getEvents({ limit: 500 });
    const types = agentEvents.map((event) => event.type.replace("events.iterate.com/", ""));
    expect(types).toContain("capability-host/script-run-requested");
    expect(types).toContain("capability-host/script-run-settled");
    expect(types).toContain("agents/web-message-sent");
  },
);

test(
  "agent answers after explicit creation selects its model",
  // See above — heavy-test ceiling.
  { timeout: 240_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "agent-model" });
    using agent = handle.agent("/agents/e2e-model");
    await agent.create({});
    const state = (await agent.processor.snapshot()).state;
    expect(state.birthCertificate?.config.llm.model).toBeTruthy();

    const response = await agent.ask({
      message: "Reply with a short greeting.",
      // Gateway turns under preview load can sit past the 45s default — a
      // single turn measured 31s healthy, worse when the shared per-minute
      // budget is saturated and the retry backoff (10/20/60s) is riding.
      timeoutMs: 180_000,
    });
    expect(response).toMatchObject({ type: "events.iterate.com/agents/web-message-sent" });

    const agentEvents = await agent.stream.getEvents({ limit: 500 });
    expect(
      agentEvents.some((event) => event.type === "events.iterate.com/agent/llm-request-started"),
    ).toBe(true);
  },
);
