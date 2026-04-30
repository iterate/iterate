import { createContext, useContext, useMemo, useState, type PropsWithChildren } from "react";
import { ChevronDownIcon, InfoIcon } from "lucide-react";
import { useLocation } from "@tanstack/react-router";
import { type StreamPath } from "@iterate-com/events-contract";
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
import { Tabs, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { streamPathFromPathname } from "~/lib/stream-links.ts";
import { streamRendererModeOptions, type StreamRendererMode } from "~/lib/stream-feed-types.ts";
import { type StreamFeedViewMode } from "~/lib/stream-view-search.ts";

type StreamHeaderControls = {
  rendererMode: StreamRendererMode;
  onRendererModeChange?: (mode: StreamRendererMode) => void;
  feedViewMode: StreamFeedViewMode;
  onFeedViewModeChange?: (mode: StreamFeedViewMode) => void;
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
    <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
      <Tabs
        value={headerControls.feedViewMode}
        onValueChange={(value) =>
          headerControls.onFeedViewModeChange?.(value as StreamFeedViewMode)
        }
      >
        <TabsList className="h-8">
          <TabsTrigger value="current" className="px-2 text-xs">
            Current
          </TabsTrigger>
          <TabsTrigger value="clean" className="px-2 text-xs">
            Clean
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* shadcn/ui's Dropdown Menu radio group is a better fit than Select here
          because the options need short explanations, not just terse labels.
          First-party docs: https://github.com/shadcn-ui/ui/blob/main/apps/v4/content/docs/components/base/dropdown-menu.mdx */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="w-24 min-w-0 justify-between gap-2 text-left max-[359px]:w-8 max-[359px]:justify-center max-[359px]:px-0 sm:w-56"
            />
          }
        >
          <span className="truncate max-[359px]:sr-only">{selectedRendererMode.label}</span>
          <ChevronDownIcon className="size-4 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[min(20rem,calc(100vw-1rem))]">
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
