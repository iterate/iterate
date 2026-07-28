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
    await appendSyntheticProviderOutput(
      agent.stream,
      `Reading the saved output now.\n\n\`\`\`ts\n${script}\n\`\`\``,
    );

    // Sync on the script finishing, keeping its error (if any) so a
    // regression reports the actual script failure instead of a poll timeout.
    let completionError: string | null = null;
    await waitForCondition(
      async () => {
        const events = await agent.stream.getEvents({
          eventTypes: ["events.iterate.com/capability-host/script-run-settled"],
          limit: 100,
        });
        const completion = events.at(0);
        if (completion === undefined) return false;
        completionError =
          typeof completion.payload?.error === "string" ? completion.payload.error : null;
        return true;
      },
      { description: "the agent's script to finish", intervalMs: 1_000, timeoutMs: 120_000 },
    );
    expect(completionError).toBeNull();

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
