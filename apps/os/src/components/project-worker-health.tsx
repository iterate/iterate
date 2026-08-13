import { useMemo, useState } from "react";
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
  type SubscriptionHealth,
} from "./project-worker-health-logic.ts";

/**
 * Loud sidebar warning when a subscription on the project's ROOT (`/`) stream
 * is not delivering: HALTED (delivery gave up after sustained failure and
 * stopped, so its receiver stops seeing events until someone resumes it) or
 * in BACKOFF (delivery is failing and retrying — not stopped yet, but may
 * halt). Either way events pile up undelivered — a project-level "something
 * is wrong".
 *
 * Read-side only. It reads the `/` stream's own `liveState`, which is
 * authoritative about each subscription's durable halt/park facts and runtime
 * retry time. Nothing pushes into the project DO — the stream stays
 * ignorant of the sidebar.
 *
 * Scope for now: `/` only. A userspace processor that struggles on a CHILD
 * stream (the prod `/guestbook` case) is NOT caught here yet — that needs a
 * project rollup across every stream and is deliberately out of scope.
 */
export function ProjectWorkerHealthWarning({ projectId }: { projectId: string | null }) {
  const [open, setOpen] = useState(false);
  const subscriptionState = useLiveState(
    (itx) => itx.streams.get("/").liveState,
    (state) => ({
      configured: state.coreProcessorState.subscriptions.outbound.byName,
      runtime: state.runtime.subscriptions,
    }),
    [projectId],
    { slug: projectId ?? "", enabled: !!projectId },
  ).value;
  const struggling = useMemo(
    () => selectStrugglingSubscriptions(subscriptionState),
    [subscriptionState],
  );

  if (!struggling.length) return null;

  const haltedCount = struggling.filter((subscription) => subscription.status === "halted").length;
  // Halted is the loud, red state; backoff-only is an amber "events are
  // piling up" heads-up.
  const severe = haltedCount > 0;
  const label = severe
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
                <span className="flex-1 font-medium">{label}</span>
                <span className="text-xs opacity-70">Fix…</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <StrugglingSubscriptionsSheet
        open={open}
        onOpenChange={setOpen}
        projectId={projectId}
        struggling={struggling}
        severe={severe}
      />
    </>
  );
}

function StrugglingSubscriptionsSheet({
  open,
  onOpenChange,
  projectId,
  struggling,
  severe,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  struggling: SubscriptionHealth[];
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
            {severe ? "Event delivery stopped" : "Event delivery not flowing"}
          </SheetTitle>
          <SheetDescription>
            {severe
              ? "A subscription on this project's root stream halted after repeated failures. New events pile up undelivered until you resume it."
              : "A subscription on this project's root stream keeps failing and is retrying with backoff. Events pile up undelivered until delivery resumes."}{" "}
            Resume retries from where it stopped; if one event keeps breaking delivery, skip past
            it.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="divide-y">
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
                    </div>
                  ) : null}
                  <div className="flex gap-2 pt-1">
                    {halted ? (
                      <Button
                        size="sm"
                        onClick={() => run("resume", subscription)}
                        disabled={!!pending}
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
                        disabled={!!pending}
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
