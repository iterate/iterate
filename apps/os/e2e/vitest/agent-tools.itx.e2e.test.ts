/**
 * Goal coverage: an agent uses itx tools. Deterministic version of the
 * Playwright chat spec — drive an agent over itx, instruct it to run a script
 * that appends a proof event, and assert the full codemode loop on the stream:
 * llm request → output → itx/script-execution-requested/completed → proof
 * event on the target stream → visible web reply.
 */
import { test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";

const PROOF_STREAM = "/e2e/agent-tools-proof";
const PROOF_TYPE = "events.iterate.test/agent-tools-proof";

test(
  "agent runs an itx script that appends a proof event, then replies",
  { timeout: 300_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "agent-tools" });
    using agent = handle.agent("/agents/e2e-tools");

    const marker = crypto.randomUUID().slice(0, 8);
    await agent.ask({
      message: [
        `Run a script that appends one event of type ${PROOF_TYPE} with payload`,
        `{ "marker": "${marker}" } to the stream ${PROOF_STREAM} via`,
        `itx.streams.get(${JSON.stringify(PROOF_STREAM)}).append(...). After the script`,
        `runs, send a chat message that contains exactly the word done.`,
      ].join(" "),
    });

    // The reply may arrive before or after the script completes depending on
    // how the model ordered its actions — poll both effects independently.
    using itx = handle.itx();
    await expect
      .poll(
        async () => {
          const events = await itx.streams.get(PROOF_STREAM).getEvents({});
          return events.some(
            (event) => event.type === PROOF_TYPE && event.payload?.marker === marker,
          );
        },
        { interval: 1_000, timeout: 120_000 },
      )
      .toBe(true);

    const agentEvents = await agent.stream.getEvents({ limit: 500 });
    const types = agentEvents.map((event) => event.type.replace("events.iterate.com/", ""));
    expect(types).toContain("itx/script-execution-requested");
    expect(types).toContain("itx/script-execution-completed");
    expect(types).toContain("agents/web-message-sent");
  },
);

test(
  "provider toggle: cloudflare-ai answers after llm-provider-selected",
  { timeout: 300_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "provider-toggle" });
    using agent = handle.agent("/agents/e2e-provider");

    // Force the toggle regardless of the deployment's default provider.
    await agent.stream.append({
      type: "events.iterate.com/agent/llm-provider-selected",
      // The contract requires the model alongside the provider; a model-less
      // append is schema-invalid and wedges the agent processor's ingest.
      payload: { model: "@cf/moonshotai/kimi-k2.7-code", provider: "cloudflare-ai" },
    });

    const response = await agent.ask({ message: "Reply with a short greeting." });
    expect(response.type).toBe("events.iterate.com/agents/web-message-sent");

    const agentEvents = await agent.stream.getEvents({ limit: 500 });
    expect(
      agentEvents.some(
        (event) => event.type === "events.iterate.com/cloudflare-ai/llm-request-started",
      ),
    ).toBe(true);
  },
);
