import { useMemo } from "react";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Button } from "../../../components/ui/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { SerializedObjectCodeBlock } from "../../../components/serialized-object-code-block.tsx";
import { Empty, EmptyDescription, EmptyTitle } from "../../../components/ui/empty.tsx";
import { useEstateId } from "../../../hooks/use-estate.ts";
import { useTRPC } from "../../../lib/trpc.ts";
import type { EstateOnboardingStep } from "../../../../types/estate-onboarding.ts";

function getBadgeVariant(state: string) {
  switch (state) {
    case "error":
      return "destructive" as const;
    case "pending":
      return "secondary" as const;
    case "completed":
      return "outline" as const;
    default:
      return "default" as const;
  }
}

function formatStateLabel(state: string) {
  return state.replace(/_/g, " ");
}

export default function EstateOnboardingStatus() {
  const estateId = useEstateId();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(trpc.estate.get.queryOptions({ estateId }));

  const onboarding = data.onboarding;

  const handleRefresh = () => {
    queryClient.invalidateQueries({
      queryKey: trpc.estate.get.getQueryKey({ estateId }),
    });
  };

  if (!onboarding) {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Estate onboarding</h1>
          <p className="text-muted-foreground">
            This estate does not have an active onboarding workflow.
          </p>
        </div>
        <Empty>
          <EmptyTitle>No onboarding workflow found</EmptyTitle>
          <EmptyDescription>
            When an estate onboarding workflow is running, its progress will appear here.
          </EmptyDescription>
        </Empty>
      </div>
    );
  }

  const steps: EstateOnboardingStep[] = onboarding.data?.steps ?? [];
  const lastUpdatedText = onboarding.updatedAt
    ? formatDistanceToNow(new Date(onboarding.updatedAt), { addSuffix: true })
    : null;

  const workflowStateBadge = getBadgeVariant(onboarding.state);
  const workflowStateLabel = formatStateLabel(onboarding.state);

  const orderedSteps = useMemo(
    () =>
      [...steps].sort((a, b) => {
        const aCompleted = a.completedAt ? new Date(a.completedAt).getTime() : 0;
        const bCompleted = b.completedAt ? new Date(b.completedAt).getTime() : 0;
        return aCompleted - bCompleted;
      }),
    [steps],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Estate onboarding</h1>
          <p className="text-muted-foreground">
            Review the current progress of the automated onboarding workflow for this estate.
          </p>
        </div>
        <Button variant="outline" onClick={handleRefresh}>
          Refresh status
        </Button>
      </div>
      <Card variant="muted">
        <CardHeader>
          <div className="space-y-1">
            <CardTitle>Workflow status</CardTitle>
            <CardDescription>Instance ID: {onboarding.id}</CardDescription>
            {lastUpdatedText ? (
              <p className="text-sm text-muted-foreground">Last updated {lastUpdatedText}</p>
            ) : null}
          </div>
          <CardAction>
            <Badge variant={workflowStateBadge} className="capitalize">
              {workflowStateLabel}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 pb-6">
          <div className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Steps
            </h2>
            {orderedSteps.length > 0 ? (
              <ul className="flex flex-col gap-3">
                {orderedSteps.map((step) => {
                  const stepStatusBadge = getBadgeVariant(step.status);
                  const stepLabel = formatStateLabel(step.status);
                  const completedText = step.completedAt
                    ? formatDistanceToNow(new Date(step.completedAt), { addSuffix: true })
                    : null;
                  const startedText = step.startedAt
                    ? formatDistanceToNow(new Date(step.startedAt), { addSuffix: true })
                    : null;

                  return (
                    <li
                      key={step.name}
                      className="flex flex-col gap-1 rounded-lg border border-border/60 bg-background/60 p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium capitalize">
                          {step.name.replace(/_/g, " ")}
                        </span>
                        <Badge variant={stepStatusBadge} className="capitalize">
                          {stepLabel}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground space-x-2">
                        {startedText ? <span>Started {startedText}</span> : null}
                        {completedText ? <span>Completed {completedText}</span> : null}
                      </div>
                      {step.detail ? (
                        <p className="text-sm text-muted-foreground/90">{step.detail}</p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No workflow steps have been recorded yet.
              </p>
            )}
          </div>
          <div className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Workflow payload
            </h2>
            <SerializedObjectCodeBlock
              data={onboarding.data}
              initialFormat="json"
              className="max-h-[360px]"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
