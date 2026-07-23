import { SlidersHorizontalIcon } from "lucide-react";
import type { RowField } from "../lib/board-model.ts";
import { Button } from "./ui/button.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { WithTooltip } from "./checkout-header.tsx";

const GROUPINGS: { label: string; value: RowField }[] = [
  { label: "No grouping", value: null },
  { label: "Group by tag", value: "label" },
  { label: "Group by folder", value: "folder" },
];

/** Board settings: grouping + change tracking, behind the sliders icon. */
export function BoardSettings({
  grouping,
  onChangeGrouping,
  trackChanges,
  onChangeTrackChanges,
}: {
  grouping: RowField;
  onChangeGrouping: (value: RowField) => void;
  trackChanges: boolean;
  onChangeTrackChanges: (value: boolean) => void;
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
        <div className="mt-2 border-t pt-2">
          <label
            htmlFor="track-changes-toggle"
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
          >
            <Checkbox
              id="track-changes-toggle"
              checked={trackChanges}
              onCheckedChange={(next) => onChangeTrackChanges(next === true)}
            />
            Track changes
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}
