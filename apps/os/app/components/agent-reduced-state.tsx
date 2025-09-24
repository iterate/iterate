import { useMemo, useState } from "react";
import jsonata from "jsonata/sync";
import type { AugmentedCoreReducedState } from "../../backend/agent/agent-core-schemas.ts";
import { SerializedObjectCodeBlock } from "./serialized-object-code-block.tsx";
import { Input } from "./ui/input.tsx";

interface AgentReducedStateProps {
  reducedState: AugmentedCoreReducedState;
  className?: string;
}

export function AgentReducedState({ reducedState, className }: AgentReducedStateProps) {
  const [jsonataMatcher, setJsonataMatcher] = useState("");
  const matchedState = useMemo(() => {
    if (!jsonataMatcher) return { value: reducedState };
    try {
      const evaluated = jsonata(jsonataMatcher).evaluate({
        agentCoreState: reducedState,
      });
      if (!evaluated)
        return { value: reducedState, error: `jsonata expression evaluated to ${evaluated}` };
      return { value: evaluated };
    } catch (error) {
      return { value: reducedState, error: (error as Error).message };
    }
  }, [jsonataMatcher, reducedState]);

  // Calculate counts for badges
  return (
    <div className={className}>
      <div className="flex flex-row items-center gap-2 pb-2">
        <Input
          className="w-[70%]"
          value={jsonataMatcher}
          onChange={(e) => setJsonataMatcher(e.target.value)}
          placeholder="Filter state with JSONata expression"
        />
        <div className="text-red-500 w-[30%]">{matchedState.error}</div>
        {/* <SerializedObjectCodeBlock data={matchedState.value} className="h-full" /> */}
      </div>
      <SerializedObjectCodeBlock data={matchedState.value || reducedState} className="h-full" />
    </div>
  );
}
