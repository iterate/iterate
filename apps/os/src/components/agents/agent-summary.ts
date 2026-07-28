import { toast } from "@iterate-com/ui/components/sonner";
import { connectItx } from "iterate/sdk/itx/react";
import type { AgentSummaryUpdate } from "~/domains/agents/agent-presence.ts";

/**
 * Append one agent summary update (pin, rename, …) from any UI surface.
 * `scope` is a project id or slug — whatever the surface has. Failures toast
 * and report false so optimistic controls can settle.
 */
export async function updateAgentSummary(
  scope: string,
  path: string,
  update: AgentSummaryUpdate,
): Promise<boolean> {
  try {
    const itx = await connectItx(scope);
    await itx.agents.get(path).append({
      type: "events.iterate.com/agent/summary-updated",
      payload: update,
    });
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Could not update agent.");
    return false;
  }
}
