import { isAgentRuntimeVisiblyActive } from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { AgentLiveState } from "../itx-api.generated.ts";

/** Combines agent progress with the runtime whose feed publications are already on screen. */
export function presentAgentProgress(
  presented: AgentLiveState["runtimeChange"],
  agent: AgentLiveState | undefined,
) {
  const current = agent?.runtimeChange;
  const latest =
    current && current.sinceOffset > (presented?.sinceOffset ?? 0) ? current : presented || current;
  // New work is visible immediately. An idle transition waits until the
  // corresponding feed publications arrive, so progress never vanishes early.
  const agentRuntime = isAgentRuntimeVisiblyActive(latest?.runtime)
    ? latest?.runtime
    : (presented?.runtime ?? latest?.runtime);
  // Counts can stay unchanged across inputs. Compare runtime revisions, not
  // the submitted input offset, before releasing the local submission state.
  const runtimePresented = (presented?.sinceOffset ?? 0) >= (current?.sinceOffset ?? 0);
  const inputAcknowledgedThroughOffset = runtimePresented
    ? (agent?.inputAcknowledgedThroughOffset ?? 0)
    : 0;
  return { agentRuntime, inputAcknowledgedThroughOffset };
}
