import { env } from "../../env.ts";
import {
  CORE_AGENT_SLICES,
  IterateAgent,
  type AgentInitParams,
  type CoreAgentSlices,
} from "./iterate-agent.ts";

export class OnboardingAgent extends IterateAgent {
  static override getNamespace() {
    return env.ONBOARDING_AGENT as unknown as typeof env.ITERATE_AGENT;
  }

  protected getSlices(): CoreAgentSlices {
    return CORE_AGENT_SLICES;
  }

  async initIterateAgent(params: AgentInitParams) {
    await super.initIterateAgent(params);

    const currentModelOpts = this.agentCore.state.modelOpts;

    if (currentModelOpts.toolChoice !== "required") {
      this.agentCore.addEvent({
        type: "CORE:SET_MODEL_OPTS",
        data: {
          ...currentModelOpts,
          toolChoice: "required",
        },
      });
    }
  }
}
