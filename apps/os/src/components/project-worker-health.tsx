import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { ScrollArea } from "@iterate-com/ui/components/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/sidebar";
import { toast } from "@iterate-com/ui/components/sonner";
import { cn } from "@iterate-com/ui/lib/utils";
import { useItx, useLiveState } from "iterate/sdk/itx/react";
import {
  buildRedriveEvents,
  selectStrugglingSubscriptions,
  selectWorkerBuildFailure,
  type SubscriptionHealth,
  type WorkerBuildFailureFact,
} from "./project-worker-health-logic.ts";

/**
 * Loud sidebar warning when a subscription on the project's ROOT (`/`) stream
 * is not delivering: HALTED (delivery gave up after sustained failure and
 * stopped, so its receiver stops seeing events until someone resumes it) or
 * in BACKOFF (delivery is failing and retrying — not stopped yet, but may
 * halt). Either way events pile up undelivered — a project-level "something
 * is wrong".
 *
 * Read-side only, and push facts only: the `/` stream's own `liveState`
 * (authoritative about each subscription's durable halt/park facts and
 * runtime retry state) plus the project's reduced `worker` outcome — a
 * standing `project/worker-update-failed` renders red until a later
 * worker-updated supersedes it. Nothing here dials other streams: a
 * cross-stream sweep is an admin script, not a dashboard poll (see
 * apps/os/docs/worker-health-runbook.md).
 */
export function ProjectWorkerHealthWarning({
  projectId,
  projectSlug,
}: {
  projectId: string | null;
  projectSlug: string;
}) {
  const [open, setOpen] = useState(false);
  const subscriptionState = useLiveState(
    (itx) => itx.streams.get("/").liveState,
    (state) => ({
      configured: state.coreProcessorState.subscriptions.outbound.byName,
      runtime: state.runtime.subscriptions,
    }),
    [projectId],
    { slug: projectId ?? "", enabled: projectId !== null },
  ).value;
  const struggling = useMemo(
    () => selectStrugglingSubscriptions(subscriptionState),
    [subscriptionState],
  );
  // The durable worker outcome: `project/worker-update-failed` renders red
  // until a later worker-updated supersedes it in the reduced slot.
  const workerOutcome = useLiveState(
    (itx) => itx.liveState,
    (state) => state.reduced.worker,
    [projectId],
    { slug: projectId ?? "", enabled: projectId !== null },
  ).value;
  const buildFailure = selectWorkerBuildFailure(workerOutcome);

  if (struggling.length === 0 && buildFailure === null) return null;

  const haltedCount = struggling.filter((subscription) => subscription.status === "halted").length;
  // A build failure and halted are the loud, red states; backoff-only is an
  // amber "events are piling up" heads-up.
  const severe = haltedCount > 0 || buildFailure !== null;
  // Short enough for one sidebar line; the tooltip and sheet carry detail.
  const label =
    buildFailure !== null
      ? "Worker build failed"
      : haltedCount > 0
        ? haltedCount === 1
          ? "Event delivery stopped"
          : `${haltedCount} event deliveries stopped`
        : struggling.length === 1
          ? "Event delivery retrying"
          : `${struggling.length} event deliveries struggling`;

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              {/* Styled as a real button (border + fill), not a quiet menu row:
                  this is the click that opens the resume/skip sheet, and it
                  must read as clickable at a glance. */}
              <SidebarMenuButton
                tooltip={label}
                onClick={() => setOpen(true)}
                className={cn(
                  "border",
                  severe
                    ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive focus-visible:text-destructive"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 hover:text-amber-600 focus-visible:text-amber-600 dark:text-amber-500 dark:hover:text-amber-500 dark:focus-visible:text-amber-500",
                )}
              >
                <TriangleAlert className="motion-safe:animate-pulse" />
                {/* The LABEL truncates (the tooltip repeats it in full); the
                    action affordance never does — and it carries no ellipsis,
                    which read as accidental truncation next to a long label. */}
                <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
                <span className="shrink-0 text-xs whitespace-nowrap opacity-70">Fix</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <StrugglingSubscriptionsSheet
        open={open}
        onOpenChange={setOpen}
        projectId={projectId}
        projectSlug={projectSlug}
        struggling={struggling}
        buildFailure={buildFailure}
        severe={severe}
      />
    </>
  );
}

function StrugglingSubscriptionsSheet({
  open,
  onOpenChange,
  projectId,
  projectSlug,
  struggling,
  buildFailure,
  severe,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  projectSlug: string;
  struggling: SubscriptionHealth[];
  buildFailure: WorkerBuildFailureFact | null;
  severe: boolean;
}) {
  const itx = useItx(projectId ?? undefined);
  // Keyed `${name}:${action}` so a single row's button shows pending while
  // every other button disables — no two redrives race the same stream.
  const [pending, setPending] = useState<string | null>(null);

  async function run(action: "resume" | "skip", subscription: SubscriptionHealth) {
    setPending(`${subscription.name}:${action}`);
    try {
      await itx.streams.get("/").append(...buildRedriveEvents(action, subscription));
      toast.success(
        action === "skip" ? "Skipped the stuck event and resumed delivery" : "Resumed delivery",
      );
    } catch (error) {
      toast.error(`Couldn't resume: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPending(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 data-[side=right]:sm:w-[min(92vw,32rem)]">
        <SheetHeader className="border-b px-4 py-3 pr-14">
          <SheetTitle
            className={cn(
              "flex items-center gap-2",
              severe ? "text-destructive" : "text-amber-600 dark:text-amber-500",
            )}
          >
            <TriangleAlert className="size-4" />
            {buildFailure !== null
              ? "Project worker build failed"
              : severe
                ? "Event delivery stopped"
                : "Event delivery not flowing"}
          </SheetTitle>
          <SheetDescription>
            {buildFailure !== null
              ? "The project worker no longer builds, so nothing that depends on it runs — agents included — until a config repo commit fixes the build."
              : severe
                ? "A subscription on this project's root stream halted after repeated failures. New events pile up undelivered until you resume it. Resume retries from where it stopped; if one event keeps breaking delivery, skip past it."
                : "A subscription on this project's root stream keeps failing and is retrying with backoff. Events pile up undelivered until delivery resumes. Resume retries from where it stopped; if one event keeps breaking delivery, skip past it."}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="divide-y">
            {buildFailure === null ? null : (
              <div className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-[10px] font-medium tracking-wide uppercase text-destructive">
                    Build failed
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    config repo @ {buildFailure.commitOid.slice(0, 7)}
                  </span>
                </div>
                <div className="text-xs break-words whitespace-pre-wrap text-destructive">
                  {buildFailure.error}
                </div>
                <div className="pt-1">
                  {/* The incident-shaped fix path: broken worker → open the
                      config repo and fix the code. */}
                  <Button
                    size="sm"
                    variant="outline"
                    render={
                      <Link
                        to="/projects/$projectSlug/repos/$"
                        params={{ projectSlug, _splat: "config" }}
                        search={{}}
                        onClick={() => onOpenChange(false)}
                      />
                    }
                  >
                    Open config repo
                  </Button>
                </div>
              </div>
            )}
            {struggling.map((subscription) => {
              const halted = subscription.status === "halted";
              return (
                <div key={subscription.name} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "shrink-0 text-[10px] font-medium tracking-wide uppercase",
                        halted ? "text-destructive" : "text-amber-600 dark:text-amber-500",
                      )}
                    >
                      {halted ? "Halted" : "Retrying"}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {subscription.name}
                    </span>
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <dt>{halted ? "Halted after" : "Stuck after"}</dt>
                    <dd className="tabular-nums">
                      offset{" "}
                      {halted ? subscription.haltedAfterOffset : subscription.confirmedOffset}
                    </dd>
                    <dt>Behind</dt>
                    <dd className="tabular-nums">
                      {subscription.lag} event{subscription.lag === 1 ? "" : "s"}
                    </dd>
                    <dt>Attempts</dt>
                    <dd className="tabular-nums">{subscription.attempt}</dd>
                  </dl>
                  {subscription.lastError ? (
                    <div
                      className={cn(
                        "text-xs break-words whitespace-pre-wrap",
                        halted ? "text-destructive" : "text-amber-600 dark:text-amber-500",
                      )}
                    >
                      {subscription.lastError}
                      {subscription.lastErrorAt === null ? null : (
                        <span className="opacity-70">
                          {" "}
                          ({timeAgoLabel(subscription.lastErrorAt)})
                        </span>
                      )}
                    </div>
                  ) : null}
                  <div className="flex gap-2 pt-1">
                    {halted ? (
                      <Button
                        size="sm"
                        onClick={() => run("resume", subscription)}
                        disabled={pending !== null}
                      >
                        {pending === `${subscription.name}:resume`
                          ? "Resuming…"
                          : "Resume delivery"}
                      </Button>
                    ) : null}
                    {subscription.canSetCursor ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => run("skip", subscription)}
                        disabled={pending !== null}
                      >
                        {pending === `${subscription.name}:skip`
                          ? "Skipping…"
                          : "Skip stuck event & resume"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

/** Compact "3d ago"-style age; falls back to the raw timestamp when unparsable. */
function timeAgoLabel(at: string): string {
  const thenMs = Date.parse(at);
  if (Number.isNaN(thenMs)) return at;
  const elapsedMs = Math.max(0, Date.now() - thenMs);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
