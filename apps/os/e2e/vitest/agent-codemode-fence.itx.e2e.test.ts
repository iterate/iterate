/**
 * Goal coverage: an assistant reply whose script embeds a markdown fence
 * inside a string literal executes in full. No LLM involved — the reply is
 * synthesized directly on the agent stream, exactly as an LLM provider
 * journals it (assistant agents/context-added with an llmRequestOffset), then
 * the script runs in a real dynamic worker. Repro of a prd incident
 * (agents/web/2026-07-09t14-21-45-359z):
 * agents that send markdown-formatted chat messages write scripts containing
 * ``` inside strings; the reply used to be cut at that inner fence, the
 * unparseable prefix failed with "Invalid or unexpected token", and the
 * user-visible message never went out.
 */
import { test } from "vitest";
import { ScriptExecutionSettlement } from "../../src/domains/capability-host/script-execution-settlement.ts";
import { createTestProject } from "../test-support/create-test-project.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { appendSyntheticProviderOutput } from "./itx-test-support.ts";

test(
  "a script that embeds a markdown fence in a string literal runs in full",
  { timeout: 240_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "codemode-fence" });
    using agent = handle.agent("/agents/e2e-codemode-fence");
    await agent.create();

    // The reply an LLM provider would journal: prose, then one fenced script
    // whose sendMessage argument itself contains a ```text block.
    const marker = crypto.randomUUID().slice(0, 8);
    const script = [
      "async (itx) => {",
      `  await itx.chat.sendMessage("Tail (${marker}):\\n\`\`\`text\\n" + "0123456789".slice(-4) + "\\n\`\`\`");`,
      "}",
    ].join("\n");
    const { assistantContext } = await appendSyntheticProviderOutput(
      agent.stream,
      `Reading the saved output now.\n\n\`\`\`ts\n${script}\n\`\`\``,
    );
    const executionId = `agent-output:${assistantContext.offset}`;

    // Sync on this synthetic reply's exact script. Other work can settle on the
    // same agent stream, so the first settlement is not a completion boundary
    // for this request.
    let settlement: ReturnType<typeof ScriptExecutionSettlement.parse> | undefined;
    await waitForCondition(
      async () => {
        const events = await agent.stream.getEvents({
          eventTypes: ["events.iterate.com/capability-host/script-run-settled"],
          limit: 100,
        });
        const completion = events.find((event) => event.payload?.executionId === executionId);
        if (!completion) return false;
        settlement = ScriptExecutionSettlement.parse(completion.payload?.settlement);
        return true;
      },
      {
        description: `the agent's script ${executionId} to finish`,
        intervalMs: 1_000,
        timeoutMs: 120_000,
      },
    );
    expect(settlement).toMatchObject({ status: "succeeded" });

    // The user-visible outcome: the exact message the script sent, fence and
    // all — proof the code AFTER the embedded ``` executed.
    const messages = await agent.stream.getEvents({
      eventTypes: ["events.iterate.com/agents/web-message-sent"],
      limit: 100,
    });
    const sent = messages.map((event) => String(event.payload?.message ?? ""));
    expect(sent).toContainEqual(expect.stringContaining(marker));
    expect(sent).toContainEqual(expect.stringContaining("```text\n6789\n```"));
  },
);
