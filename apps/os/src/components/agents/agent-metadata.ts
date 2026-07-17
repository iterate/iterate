import { toast } from "@iterate-com/ui/components/sonner";
import { connectItx } from "iterate/react";
import type { AgentMetadataPatch } from "~/domains/agents/agent-presence.ts";

/**
 * Apply one agent metadata patch (pin, rename, …) from any UI surface.
 * `scope` is a project id or slug — whatever the surface has. Failures toast
 * and report false so optimistic controls can settle.
 */
export async function patchAgentMetadata(
  scope: string,
  path: string,
  patch: AgentMetadataPatch,
): Promise<boolean> {
  try {
    const itx = await connectItx(scope);
    await itx.agents.get(path).setMetadata(patch);
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Could not update agent.");
    return false;
  }
}
