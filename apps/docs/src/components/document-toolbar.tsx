import type { ReactNode } from "react";
import {
  Code2Icon,
  FileTextIcon,
  MessageSquarePlusIcon,
  PenLineIcon,
  SparklesIcon,
} from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { authorLabel } from "@iterate-com/workspace-documents/collab";
import { ShareButton, WithTooltip } from "./board-header.tsx";
import { WorkspacePresence } from "./workspace-presence.tsx";
import { ViewButton } from "./view-button.tsx";

export function DocumentToolbar({
  path,
  format,
  peers,
  status,
  onReconnect,
  canComment,
  onComment,
  showChanges,
  onShowChangesChange,
  view,
  onViewChange,
  actions,
}: {
  path: string;
  format: string;
  peers: { self: string; clientIds: string[] } | null;
  status: string;
  onReconnect: () => void;
  canComment: boolean;
  onComment: () => void;
  showChanges: boolean;
  onShowChangesChange: (value: boolean) => void;
  view: "rich" | "source";
  onViewChange: (value: "rich" | "source") => void;
  actions?: ReactNode;
}) {
  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2">
      <SidebarTrigger className="-ml-1 md:hidden" />
      <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <h1 className="min-w-0 truncate font-mono text-xs">{path}</h1>
      <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
        <WorkspacePresence
          self={peers ? { clientId: peers.self, name: authorLabel(peers.self) } : null}
          clients={(peers?.clientIds ?? []).map((clientId) => ({
            clientId,
            name: authorLabel(clientId),
          }))}
        />
        {/* live is the expected state — visually silent, but kept in the
              accessibility tree (it is the only place the sync state lives). */}
        <span
          className={
            status.startsWith("live")
              ? "sr-only"
              : "hidden max-w-40 truncate text-[11px] text-muted-foreground md:block"
          }
        >
          {status}
        </span>
        {/* The editor could not open, or its sync loop gave up (a long
              outage): remount it. Its teardown pushes whatever it still
              holds over the shared session (which may have been re-dialed
              since), and the fresh editor reopens from the server. */}
        {status.startsWith("disconnected") || status.startsWith("failed") ? (
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onReconnect}>
            Reconnect
          </Button>
        ) : null}
        <WithTooltip
          label={canComment ? "Comment on document" : "Comments are currently read-only"}
        >
          <Button
            size="sm"
            className="h-8 w-8 px-0"
            aria-label="Comment on document"
            disabled={!canComment}
            onClick={onComment}
          >
            <MessageSquarePlusIcon aria-hidden className="size-3.5" />
          </Button>
        </WithTooltip>
        <WithTooltip label={showChanges ? "Hide changes" : "Track changes"}>
          <Button
            variant={showChanges ? "secondary" : "outline"}
            size="icon-sm"
            aria-label="Track changes"
            aria-pressed={showChanges}
            onClick={() => onShowChangesChange(!showChanges)}
          >
            <SparklesIcon />
          </Button>
        </WithTooltip>
        <ShareButton />
        <div className="flex rounded-lg border bg-muted/30 p-0.5">
          <WithTooltip label="Rich editing">
            <ViewButton
              active={view === "rich"}
              label="Rich editing"
              onClick={() => onViewChange("rich")}
            >
              <PenLineIcon aria-hidden className="size-3.5" />
            </ViewButton>
          </WithTooltip>
          <WithTooltip label={`Source (${format})`}>
            <ViewButton
              active={view === "source"}
              label="Source"
              onClick={() => onViewChange("source")}
            >
              <Code2Icon aria-hidden className="size-3.5" />
            </ViewButton>
          </WithTooltip>
        </div>
        {actions}
      </div>
    </header>
  );
}
