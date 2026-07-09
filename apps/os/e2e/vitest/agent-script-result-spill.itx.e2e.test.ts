/**
 * Goal coverage: oversized script results spill into the agent's workspace.
 * No LLM involved — the codemode "tool result" event is synthesized directly
 * on the agent stream, exactly as the capability host journals it for an
 * agent-requested script (executionId prefix "agent-output:"). The agent
 * processor must render an input that references a workspace file holding the
 * FULL result; before the spill landed it hard-sliced at 30k chars and the
 * rest of the data was gone.
 */
import { test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";

const AGENT_PATH = "/agents/e2e-script-spill";

test(
  "an oversized script result spills to a workspace file the agent can page through",
  { timeout: 180_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "script-spill" });
    using agent = handle.agent(AGENT_PATH);
    using itx = handle.itx();

    // The spill writes into the agent's workspace, whose first use clones the
    // project repo — and the repo seeds asynchronously after project creation.
    // Wait for the seed BEFORE synthesizing the completion event: a spill that
    // fails falls back to inline truncation and the rendered input is
    // idempotency-keyed, so there is no second chance for that event.
    await waitForCondition(
      async () => {
        const read = await itx.repo.readFile({ path: "package.json" }).catch(() => null);
        return read !== null;
      },
      { description: "project repo to be seeded", intervalMs: 1_000, timeoutMs: 60_000 },
    );

    // Well past the 30k-char context limit AND past the workspace's 1.5MB
    // inline threshold, so this also proves the R2 spillover lane end to end
    // (on pre-R2 deployments a write this size was rejected outright). The
    // marker sits in the tail — the part the pre-spill behavior threw away.
    const marker = crypto.randomUUID();
    const result = { blob: "x".repeat(2_500_000), marker };
    await agent.stream.append({
      type: "events.iterate.com/capability-host/script-execution-completed",
      payload: { executionId: "agent-output:1", result },
    });

    // The agent processor wakes on the append and renders the tool-result
    // input; with the spill it names the workspace file instead of only the
    // "return less" hint. On pre-spill deployments this poll times out.
    let content = "";
    await waitForCondition(
      async () => {
        const events = await agent.stream.getEvents({ limit: 500 });
        const input = events.find(
          (event) =>
            event.type === "events.iterate.com/agent/input-added" &&
            String(event.payload?.content ?? "").includes("saved in your workspace"),
        );
        content = String(input?.payload?.content ?? "");
        return content !== "";
      },
      { description: "spill-referencing agent input", intervalMs: 1_000, timeoutMs: 90_000 },
    );

    const referencedPath = /saved in your workspace at "([^"]+)"/.exec(content)?.[1];
    expect(referencedPath).toBe("/script-results/agent-output-1.json");
    // The recipe the model is told to run next turn names the same file.
    expect(content).toContain(`itx.workspace.readFile(${JSON.stringify(referencedPath)})`);
    // The inline preview stayed bounded — full result only in the file.
    expect(content.length).toBeLessThan(35_000);

    // The file holds the COMPLETE serialized result, marker and all — the
    // exact bytes the model's next-turn readFile sees.
    using workspace = itx.workspaces.get(`/workspaces${AGENT_PATH}`);
    const spilled = await workspace.readFile(referencedPath!);
    expect(spilled).not.toBeNull();
    expect(JSON.parse(spilled!)).toEqual(result);
  },
);
