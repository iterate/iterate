import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { toast } from "@iterate-com/ui/components/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { useItx, useItxQuery } from "iterate/sdk/itx/react";
import type { ScheduleView, SchedulerRecurrence } from "../../../../domains/scheduler/types.ts";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { SCHEDULER_PRIMARY_PATH } from "~/domains/scheduler/utils.ts";
import { formatRelativeTime, formatTimeAgo } from "~/lib/format-relative-time.ts";
import {
  breadcrumbLoaderData,
  streamBreadcrumb,
  streamPageStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/scheduler")({
  staticData: streamPageStaticData(),
  validateSearch: StreamViewSearch,
  ssr: false,
  loader: ({ context }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: streamBreadcrumb(context.project, SCHEDULER_PRIMARY_PATH),
    }),
  component: ProjectSchedulerContent,
});

function ProjectSchedulerContent() {
  const { project } = Route.useLoaderData();
  const itx = useItx();
  const queryClient = useQueryClient();
  // The list is the Scheduler's reduced state, read fresh from the Scheduler
  // DO. Triggers fire server-side without a state push to this page, so
  // mutations invalidate explicitly and the stream feed alongside shows the
  // live event flow.
  const schedules = useItxQuery({
    key: ["scheduler", project.slug],
    query: (itx) => itx.scheduler.list(),
  });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["itx", "scheduler", project.slug] });

  const triggerSchedule = useMutation({
    mutationFn: async (key: string) => await itx.scheduler.trigger(key),
    onSuccess: async (_result, key) => {
      await invalidate();
      toast.success(`Triggered "${key}"`);
    },
    onError: (error) => toast.error(`Failed to trigger: ${error.message}`),
  });
  const cancelSchedule = useMutation({
    mutationFn: async (key: string) => await itx.scheduler.cancel(key),
    onSuccess: async (_result, key) => {
      await invalidate();
      toast.success(`Cancelled "${key}"`);
    },
    onError: (error) => toast.error(`Failed to cancel: ${error.message}`),
  });
  const pendingKey = triggerSchedule.isPending
    ? triggerSchedule.variables
    : cancelSchedule.isPending
      ? cancelSchedule.variables
      : undefined;

  const panel =
    schedules.length === 0 ? (
      <Empty className="rounded-lg border">
        <EmptyHeader>
          <EmptyTitle>No Schedules</EmptyTitle>
          <EmptyDescription>
            Schedules set via <code>itx.scheduler.set(...)</code> appear here — try the scheduler
            examples in the REPL.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : (
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Recurrence</TableHead>
              <TableHead>Next trigger</TableHead>
              <TableHead>Runs</TableHead>
              <TableHead>Set</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {schedules
              .toSorted((left, right) => compareByNextTrigger(left, right))
              .map((schedule) => (
                <TableRow key={schedule.key}>
                  <TableCell className="min-w-[12rem] py-3 text-sm font-medium">
                    <span className="block min-w-0 truncate" title={schedule.key}>
                      {schedule.key}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {recurrenceLabel(schedule.recurrence)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {!schedule.nextTriggerAt ? "—" : formatRelativeTime(schedule.nextTriggerAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{schedule.runCount}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatTimeAgo(schedule.setAt)}
                  </TableCell>
                  <TableCell className="w-0">
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!!pendingKey}
                        onClick={() => triggerSchedule.mutate(schedule.key)}
                      >
                        {pendingKey === schedule.key && triggerSchedule.isPending
                          ? "Triggering..."
                          : "Run now"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!!pendingKey}
                        onClick={() => cancelSchedule.mutate(schedule.key)}
                      >
                        {pendingKey === schedule.key && cancelSchedule.isPending
                          ? "Cancelling..."
                          : "Cancel"}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>
    );

  return (
    <ProjectStreamView
      panel={panel}
      projectId={project.id}
      streamPath={SCHEDULER_PRIMARY_PATH}
      emptyLabel="No events on the scheduler stream yet."
    />
  );
}

function recurrenceLabel(recurrence: SchedulerRecurrence) {
  if ("at" in recurrence) return "once";
  if ("every" in recurrence) return `every ${formatSeconds(recurrence.every)}`;
  return recurrence.timezone ? `${recurrence.cron} (${recurrence.timezone})` : recurrence.cron;
}

function formatSeconds(seconds: number) {
  if (seconds % 86_400 === 0 && seconds >= 86_400) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0 && seconds >= 3_600) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60}m`;
  return `${seconds}s`;
}

// Soonest next trigger first; exhausted (null) schedules sink to the bottom.
function compareByNextTrigger(
  left: Pick<ScheduleView, "key" | "nextTriggerAt">,
  right: Pick<ScheduleView, "key" | "nextTriggerAt">,
) {
  if (!left.nextTriggerAt && !right.nextTriggerAt) return left.key.localeCompare(right.key);
  if (!left.nextTriggerAt) return 1;
  if (!right.nextTriggerAt) return -1;
  const byTime = Date.parse(left.nextTriggerAt) - Date.parse(right.nextTriggerAt);
  return byTime !== 0 ? byTime : left.key.localeCompare(right.key);
}
