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
import { useItx, useLiveState } from "iterate/sdk/itx/react";
import {
  buildRedriveEvents,
  selectParkedSubscriptions,
  type ParkedSubscription,
} from "./project-worker-health-logic.ts";

/**
 * Loud sidebar warning when a subscription on the project's ROOT (`/`) stream
 * has PARKED: delivery gave up after sustained failure and stopped, so the
 * config worker stops seeing events until someone resumes it. New events pile
 * up undelivered in the meantime — a project-level "something is very wrong".
 *
 * Read-side only. It reads the `/` stream's own `liveState`, which is
 * authoritative about which of its subscribers are parked (`parkedAtOffset`).
 * Nothing pushes into the project DO — the stream stays ignorant of the
 * sidebar.
 *
 * Scope for now: `/` only. A userspace processor that parks on a CHILD stream
 * (the prod `/guestbook` case) is NOT caught here yet — that needs a project
 * rollup across every stream and is deliberately out of scope for this pass.
 */
export function ProjectWorkerHealthWarning({ projectId }: { projectId: string | null }) {
  const [open, setOpen] = useState(false);
  const subscriptions = useLiveState(
    (itx) => itx.streams.get("/").liveState,
    (state) => state.runtime.subscriptions,
    [projectId],
    { slug: projectId ?? "", enabled: projectId !== null },
  ).value;
  const parked = useMemo(() => selectParkedSubscriptions(subscriptions), [subscriptions]);

  if (parked.length === 0) return null;

  const label =
    parked.length === 1 ? "Config worker stalled" : `${parked.length} subscriptions parked`;

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={label}
                onClick={() => setOpen(true)}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:text-destructive"
              >
                <TriangleAlert className="motion-safe:animate-pulse" />
                <span className="font-medium">{label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <ParkedSubscriptionsSheet
        open={open}
        onOpenChange={setOpen}
        projectId={projectId}
        parked={parked}
      />
    </>
  );
}

function ParkedSubscriptionsSheet({
  open,
  onOpenChange,
  projectId,
  parked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  parked: ParkedSubscription[];
}) {
  const itx = useItx(projectId ?? undefined);
  // Keyed `${subscriptionKey}:${action}` so a single row's button shows pending
  // while every other button disables — no two redrives race the same stream.
  const [pending, setPending] = useState<string | null>(null);

  async function run(action: "resume" | "skip", subscription: ParkedSubscription) {
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
          <SheetTitle className="flex items-center gap-2 text-destructive">
            <TriangleAlert className="size-4" />
            Config worker stalled
          </SheetTitle>
          <SheetDescription>
            A subscription on this project's root stream parked — delivery gave up after repeated
            failures and stopped. New events pile up undelivered until you resume it. Resume retries
            from where it stopped; if the same event keeps breaking delivery, skip past it.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="divide-y">
            {parked.map((subscription) => (
              <div key={subscription.subscriptionKey} className="flex flex-col gap-2 px-4 py-3">
                <div className="font-mono text-xs break-all">{subscription.subscriptionKey}</div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <dt>Parked at</dt>
                  <dd className="tabular-nums">offset {subscription.parkedAtOffset}</dd>
                  <dt>Behind</dt>
                  <dd className="tabular-nums">
                    {subscription.lag} event{subscription.lag === 1 ? "" : "s"}
                  </dd>
                  <dt>Attempts</dt>
                  <dd className="tabular-nums">{subscription.attempt}</dd>
                </dl>
                {subscription.lastError ? (
                  <div className="text-xs break-words whitespace-pre-wrap text-destructive">
                    {subscription.lastError}
                  </div>
                ) : null}
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    onClick={() => run("resume", subscription)}
                    disabled={pending !== null}
                  >
                    {pending === `${subscription.subscriptionKey}:resume`
                      ? "Resuming…"
                      : "Resume delivery"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => run("skip", subscription)}
                    disabled={pending !== null || subscription.parkedAtOffset === null}
                  >
                    {pending === `${subscription.subscriptionKey}:skip`
                      ? "Skipping…"
                      : "Skip stuck event & resume"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
