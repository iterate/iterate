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
 * is unhealthy: PARKED (delivery gave up after sustained failure and stopped,
 * so the config worker stops seeing events until someone resumes it) or in
 * BACKOFF (delivery is failing and retrying — not stopped yet, but on its way
 * to parking). Either way events pile up undelivered — a project-level
 * "something is wrong".
 *
 * Read-side only. It reads the `/` stream's own `liveState`, which is
 * authoritative about its subscribers' delivery health (`parkedAtOffset` /
 * `nextAttemptAt`). Nothing pushes into the project DO — the stream stays
 * ignorant of the sidebar.
 *
 * Scope for now: `/` only. A userspace processor that struggles on a CHILD
 * stream (the prod `/guestbook` case) is NOT caught here yet — that needs a
 * project rollup across every stream and is deliberately out of scope.
 */
export function ProjectWorkerHealthWarning({ projectId }: { projectId: string | null }) {
  const [open, setOpen] = useState(false);
  const subscriptions = useLiveState(
    (itx) => itx.streams.get("/").liveState,
    (state) => state.runtime.subscriptions,
    [projectId],
    { slug: projectId ?? "", enabled: projectId !== null },
  ).value;
  const struggling = useMemo(() => selectStrugglingSubscriptions(subscriptions), [subscriptions]);

  if (struggling.length === 0) return null;

  const parkedCount = struggling.filter((subscription) => subscription.status === "parked").length;
  // Parked is the loud, red state; backoff-only is an amber "still trying" heads-up.
  const severe = parkedCount > 0;
  const label = severe
    ? parkedCount === 1
      ? "Config worker stalled"
      : `${parkedCount} subscriptions parked`
    : struggling.length === 1
      ? "Config worker retrying"
      : `${struggling.length} subscriptions retrying`;

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={label}
                onClick={() => setOpen(true)}
                className={cn(
                  severe
                    ? "text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:text-destructive"
                    : "text-amber-600 hover:bg-amber-500/10 hover:text-amber-600 focus-visible:text-amber-600 dark:text-amber-500 dark:hover:text-amber-500 dark:focus-visible:text-amber-500",
                )}
              >
                <TriangleAlert className="motion-safe:animate-pulse" />
                <span className="font-medium">{label}</span>
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
  // Keyed `${subscriptionKey}:${action}` so a single row's button shows pending
  // while every other button disables — no two redrives race the same stream.
  const [pending, setPending] = useState<string | null>(null);

  async function run(action: "resume" | "skip", subscription: SubscriptionHealth) {
    setPending(`${subscription.subscriptionKey}:${action}`);
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
            {severe ? "Config worker stalled" : "Config worker delivery failing"}
          </SheetTitle>
          <SheetDescription>
            {severe
              ? "A subscription on this project's root stream parked — delivery gave up after repeated failures and stopped. New events pile up undelivered until you resume it."
              : "A subscription on this project's root stream keeps failing to deliver and is retrying with backoff. It has not stopped yet, but if the same event keeps breaking delivery it will park."}{" "}
            Resume retries from where it stopped; if one event keeps breaking delivery, skip past
            it.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="divide-y">
            {struggling.map((subscription) => {
              const parked = subscription.status === "parked";
              return (
                <div key={subscription.subscriptionKey} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "shrink-0 text-[10px] font-medium tracking-wide uppercase",
                        parked ? "text-destructive" : "text-amber-600 dark:text-amber-500",
                      )}
                    >
                      {parked ? "Parked" : "Retrying"}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {subscription.subscriptionKey}
                    </span>
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <dt>{parked ? "Parked at" : "Stuck at"}</dt>
                    <dd className="tabular-nums">
                      offset {parked ? subscription.parkedAtOffset : subscription.ackedOffset}
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
                        parked ? "text-destructive" : "text-amber-600 dark:text-amber-500",
                      )}
                    >
                      {subscription.lastError}
                    </div>
                  ) : null}
                  <div className="flex gap-2 pt-1">
                    {parked ? (
                      <Button
                        size="sm"
                        onClick={() => run("resume", subscription)}
                        disabled={pending !== null}
                      >
                        {pending === `${subscription.subscriptionKey}:resume`
                          ? "Resuming…"
                          : "Resume delivery"}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => run("skip", subscription)}
                      disabled={pending !== null}
                    >
                      {pending === `${subscription.subscriptionKey}:skip`
                        ? "Skipping…"
                        : "Skip stuck event & resume"}
                    </Button>
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
