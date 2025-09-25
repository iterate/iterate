import { useMemo, useState } from "react";
import jsonata from "jsonata/sync";
import type { AugmentedCoreReducedState } from "../../backend/agent/agent-core-schemas.ts";
import { cn } from "../lib/utils.ts";
import { SerializedObjectCodeBlock } from "./serialized-object-code-block.tsx";
import { AutoComplete } from "./autocomplete.tsx";

interface AgentReducedStateProps {
  reducedState: AugmentedCoreReducedState;
  className?: string;
}

export function AgentReducedState({ reducedState, className }: AgentReducedStateProps) {
  const [selectedValue, setSelectedValue] = useState("");
  const [searchValue, setSearchValue] = useState("");

  // Create items from Object.keys of reducedState with agentCoreState. prefix
  const autocompleteItems = useMemo(() => {
    return Object.keys(reducedState)
      .map((key) => ({
        value: `agentCoreState.${key}`,
        label: `agentCoreState.${key}`,
      }))
      .filter((item) => item.value.startsWith(searchValue));
  }, [reducedState, searchValue]);

  const matchedState = useMemo(() => {
    const jsonataMatcher = selectedValue || searchValue;
    if (!jsonataMatcher) return { value: reducedState };
    try {
      const evaluated = jsonata(jsonataMatcher).evaluate({
        agentCoreState: reducedState,
      });
      return { value: evaluated };
    } catch (error) {
      return { value: reducedState, error: (error as Error).message };
    }
  }, [selectedValue, searchValue, reducedState]);

  // Calculate counts for badges
  return (
    <div className={className}>
      <div className="flex flex-row items-center gap-2 pb-2">
        <div className="w-[70%]">
          <AutoComplete
            selectedValue={selectedValue}
            onSelectedValueChange={setSelectedValue}
            searchValue={searchValue}
            onSearchValueChange={setSearchValue}
            items={autocompleteItems}
            placeholder="Filter state with JSONata expression"
            emptyMessage="No state properties found"
          />
        </div>
        <div className="text-red-500 w-[30%]">{matchedState.error}</div>
        {/* <SerializedObjectCodeBlock data={matchedState.value} className="h-full" /> */}
      </div>
      <SerializedObjectCodeBlock data={matchedState.value ?? reducedState} className="h-full" />
    </div>
  );
}
