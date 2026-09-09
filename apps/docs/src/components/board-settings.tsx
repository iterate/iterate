import { SlidersHorizontalIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@iterate-com/ui/components/popover";
import type { RowField } from "../lib/board-model.ts";
import { WithTooltip } from "./board-header.tsx";

const GROUPINGS: { label: string; value: RowField }[] = [
  { label: "No grouping", value: null },
  { label: "Group by tag", value: "label" },
  { label: "Group by folder", value: "folder" },
];

/** Board settings: grouping + change tracking, behind the sliders icon. */
export function BoardSettings({
  grouping,
  onChangeGrouping,
}: {
  grouping: RowField;
  onChangeGrouping: (value: RowField) => void;
}) {
  return (
    <Popover>
      <WithTooltip label="Board settings">
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 px-0"
              aria-label="Board settings"
            />
          }
        >
          <SlidersHorizontalIcon aria-hidden className="size-3.5" />
        </PopoverTrigger>
      </WithTooltip>
      <PopoverContent align="end" className="w-56 p-2">
        <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">Grouping</p>
        <div className="flex flex-col">
          {GROUPINGS.map((option) => (
            <button
              key={option.label}
              type="button"
              className={`rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent ${
                grouping === option.value ? "bg-accent font-medium" : ""
              }`}
              onClick={() => onChangeGrouping(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
