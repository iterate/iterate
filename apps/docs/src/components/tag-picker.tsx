import { useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, PlusIcon, TagIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@iterate-com/ui/components/popover";
import { cn } from "@iterate-com/ui/lib/utils";

/**
 * The tag combobox: shows the task's tags, proposes every tag that already
 * exists anywhere in the checkout, and creates new ones from the query.
 * Writes go straight to the frontmatter (and the doc syncs them back), so
 * this and the YAML stay in lockstep.
 */
export function TagPicker({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string[];
  options: string[];
  disabled?: boolean;
  onChange: (labels: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = query.trim();
  const selected = new Set(value);
  const filtered = options.filter((option) =>
    option.toLocaleLowerCase().includes(trimmed.toLocaleLowerCase()),
  );
  const canCreate =
    trimmed !== "" &&
    !options.some((option) => option.toLocaleLowerCase() === trimmed.toLocaleLowerCase());

  const toggle = (tag: string) => {
    onChange(value.includes(tag) ? value.filter((existing) => existing !== tag) : [...value, tag]);
  };
  const create = () => {
    if (!canCreate) return;
    onChange([...value, trimmed]);
    setQuery("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-8 max-w-56 min-w-0 gap-1.5 text-xs"
            disabled={disabled}
          />
        }
      >
        <TagIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{value.length === 0 ? "Tags" : value.join(", ")}</span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2" initialFocus={inputRef}>
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              if (canCreate) create();
              else if (filtered.length > 0) toggle(filtered[0]!);
            }
            if (event.key === "Escape") setOpen(false);
          }}
          placeholder="Search or create tags…"
          aria-label="Search or create tags"
          className="mb-2 h-8 text-sm"
        />
        <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
          {filtered.map((tag) => (
            <button
              key={tag}
              type="button"
              className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
              onClick={() => toggle(tag)}
            >
              <CheckIcon
                aria-hidden
                className={cn("size-3.5", selected.has(tag) ? "opacity-100" : "opacity-0")}
              />
              <span className="truncate">{tag}</span>
            </button>
          ))}
          {canCreate ? (
            <button
              type="button"
              className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
              onClick={create}
            >
              <PlusIcon aria-hidden className="size-3.5" />
              Create &ldquo;{trimmed}&rdquo;
            </button>
          ) : null}
          {filtered.length === 0 && !canCreate ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              No tags yet — type to create one.
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
