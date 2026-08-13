import { useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { CheckIcon, LinkIcon, ListFilterIcon, MoreHorizontalIcon, XIcon } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@iterate-com/ui/components/breadcrumb";
import { Button } from "@iterate-com/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/dropdown-menu";
import { Input } from "@iterate-com/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@iterate-com/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import type { RowField } from "../lib/board-model.ts";

/**
 * The header's orientation line, in HIERARCHY order: which WORKSPACE this
 * lens renders › which view (tasks) › the base path the view is scoped to
 * (the repo mount). Repos are mounted inside every workspace, so the
 * workspace always comes first; the project is never a crumb (the app's
 * host already says which project this is).
 */
export function BoardBreadcrumbs({
  workspace,
  rootPath,
}: {
  /** The workspace path this lens renders (first level of the hierarchy). */
  workspace?: string;
  /** The base path the view is scoped to (e.g. "/repos/config"), if any. */
  rootPath?: string;
}) {
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap text-xs">
        {/* No project crumb: the whole app is one project (its host says
            which), so the hierarchy starts at the workspace. */}
        {!workspace ? (
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/" />}>workspaces</BreadcrumbLink>
          </BreadcrumbItem>
        ) : (
          <>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to="/" />} className="truncate font-mono">
                {workspace}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>tasks</BreadcrumbItem>
          </>
        )}
        {!rootPath ? null : (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="truncate font-mono">{rootPath}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/** Icon-only controls get their labels back as hover tooltips. */
export function WithTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

const ICON_BUTTON = "h-8 w-8 px-0";

/** Copy the current URL; flips to a check for a beat. */
export function ShareButton() {
  const [copied, setCopied] = useState(false);
  return (
    <WithTooltip label={copied ? "Copied!" : "Copy share link"}>
      <Button
        variant="outline"
        size="sm"
        className={ICON_BUTTON}
        aria-label="Copy share link"
        onClick={() => {
          void navigator.clipboard.writeText(window.location.href).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? (
          <CheckIcon aria-hidden className="size-3.5" />
        ) : (
          <LinkIcon aria-hidden className="size-3.5" />
        )}
      </Button>
    </WithTooltip>
  );
}

/**
 * The Linear-style filter: an icon dropdown button opening a panel with the
 * query input; while a query is active the button stays visually on.
 */
export function FilterControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <WithTooltip label={value === "" ? "Filter tasks" : `Filtered: ${value}`}>
        <PopoverTrigger
          render={
            <Button
              variant={value !== "" ? "secondary" : "outline"}
              size="sm"
              className={ICON_BUTTON}
              aria-label="Filter tasks"
            />
          }
        >
          <ListFilterIcon aria-hidden className="size-3.5" />
        </PopoverTrigger>
      </WithTooltip>
      <PopoverContent align="end" className="w-72 p-2" initialFocus={inputRef}>
        <div className="relative">
          <Input
            ref={inputRef}
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                onChange("");
                setOpen(false);
              }
              if (event.key === "Enter") setOpen(false);
            }}
            placeholder="Filter tasks by title, text, label…"
            aria-label="Filter tasks"
            className="h-8 pr-7 text-sm"
          />
          {value === "" ? null : (
            <button
              type="button"
              aria-label="Clear filter"
              className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => onChange("")}
            >
              <XIcon aria-hidden className="size-3.5" />
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Small screens: the icon cluster folds into one overflow menu (the shadcn
 * way), keeping the header to breadcrumbs + presence + Commit.
 */
export function MobileOverflow({
  filter,
  onChangeFilter,
  group,
  onChangeGroup,
}: {
  filter: string;
  onChangeFilter: (value: string) => void;
  group: RowField;
  onChangeGroup: (value: RowField) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" className={ICON_BUTTON} aria-label="More actions" />
        }
      >
        <MoreHorizontalIcon aria-hidden className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => {
            void navigator.clipboard.writeText(window.location.href);
          }}
        >
          Copy share link
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            const next = window.prompt("Filter tasks", filter);
            if (next) onChangeFilter(next);
          }}
        >
          {filter === "" ? "Filter tasks…" : `Filtered: ${filter}`}
        </DropdownMenuItem>
        <DropdownMenuCheckboxItem
          checked={group === "folder"}
          onCheckedChange={() => onChangeGroup(group === "folder" ? null : "folder")}
        >
          Group by folder
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={group === "label"}
          onCheckedChange={() => onChangeGroup(group === "label" ? null : "label")}
        >
          Group by tag
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
