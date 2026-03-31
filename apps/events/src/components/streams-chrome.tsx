import { createContext, useContext, useMemo, useState, type PropsWithChildren } from "react";
import { ChevronDownIcon, InfoIcon } from "lucide-react";
import { useLocation } from "@tanstack/react-router";
import { type StreamPath } from "@iterate-com/events-contract";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { streamPathFromPathname } from "~/lib/stream-links.ts";
import { streamRendererModeOptions, type StreamRendererMode } from "~/lib/stream-feed-types.ts";
import type { StreamFeedSummary } from "~/lib/stream-feed-summary.ts";

type StreamHeaderControls = {
  rendererMode: StreamRendererMode;
  onRendererModeChange?: (mode: StreamRendererMode) => void;
  feedSummary?: StreamFeedSummary;
};

type StreamsChromeContextValue = {
  selectedStreamPath: StreamPath | null;
  metadataOpen: boolean;
  toggleMetadata: () => void;
  closeMetadata: () => void;
  headerControls: StreamHeaderControls | null;
  setHeaderControls: (controls: StreamHeaderControls | null) => void;
};

const StreamsChromeContext = createContext<StreamsChromeContextValue | null>(null);

export function StreamsChromeProvider({ children }: PropsWithChildren) {
  const location = useLocation();
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [headerControls, setHeaderControls] = useState<StreamHeaderControls | null>(null);

  const selectedStreamPath = useMemo(
    () => streamPathFromPathname(location.pathname),
    [location.pathname],
  );

  const value = useMemo<StreamsChromeContextValue>(
    () => ({
      selectedStreamPath,
      metadataOpen: selectedStreamPath == null ? false : metadataOpen,
      toggleMetadata: () => {
        setMetadataOpen((open) => !open);
      },
      closeMetadata: () => {
        setMetadataOpen(false);
      },
      headerControls,
      setHeaderControls,
    }),
    [headerControls, metadataOpen, selectedStreamPath],
  );

  return <StreamsChromeContext.Provider value={value}>{children}</StreamsChromeContext.Provider>;
}

// oxlint-disable-next-line react/only-export-components -- hook is colocated with StreamsChromeProvider
export function useStreamsChrome() {
  const context = useContext(StreamsChromeContext);

  if (!context) {
    throw new Error("useStreamsChrome must be used within StreamsChromeProvider.");
  }

  return context;
}

export function StreamsHeaderAction() {
  const { selectedStreamPath, metadataOpen, toggleMetadata, headerControls } = useStreamsChrome();

  if (selectedStreamPath == null || headerControls == null) {
    return null;
  }

  const selectedRendererMode =
    streamRendererModeOptions.find((option) => option.value === headerControls.rendererMode) ??
    streamRendererModeOptions[0];

  return (
    <div className="flex items-center gap-2">
      {headerControls.feedSummary ? (
        <div
          className="hidden items-center gap-1.5 text-muted-foreground lg:flex"
          aria-label="Stream item counts"
        >
          <Badge
            variant="outline"
            className="px-1.5 font-mono text-[10px] font-normal tabular-nums"
          >
            Raw {headerControls.feedSummary.rawEvents}
          </Badge>
          <Badge
            variant="outline"
            className="px-1.5 font-mono text-[10px] font-normal tabular-nums"
          >
            Semantic {headerControls.feedSummary.semanticItems}
          </Badge>
        </div>
      ) : null}
      {/* shadcn/ui's Dropdown Menu radio group is a better fit than Select here
          because the options need short explanations, not just terse labels.
          First-party docs: https://github.com/shadcn-ui/ui/blob/main/apps/v4/content/docs/components/base/dropdown-menu.mdx */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="min-w-56 justify-between gap-2 text-left"
            />
          }
        >
          <span className="truncate">{selectedRendererMode.label}</span>
          <ChevronDownIcon className="size-4 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Renderer mode</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={headerControls.rendererMode}
              onValueChange={(value) =>
                headerControls.onRendererModeChange?.(value as StreamRendererMode)
              }
            >
              {streamRendererModeOptions.map((option) => (
                <DropdownMenuRadioItem
                  key={option.value}
                  value={option.value}
                  className="items-start py-2"
                >
                  <div className="flex min-w-0 flex-col gap-0.5 pr-4">
                    <span>{option.label}</span>
                    <span className="text-xs text-muted-foreground">{option.description}</span>
                  </div>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant={metadataOpen ? "secondary" : "ghost"}
              onClick={toggleMetadata}
              aria-label="Open stream info"
            />
          }
        >
          <InfoIcon />
        </TooltipTrigger>
        <TooltipContent>
          <p>Open the reduced stream state and metadata editor.</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
