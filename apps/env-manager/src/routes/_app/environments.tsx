import { useCallback, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, ExternalLink, HeartPulse, Rocket, Trash2 } from "lucide-react";
import { newWebSocketRpcSession, type RpcStub } from "iterate/sdk/capnweb";
import { CapnWebProvider, useCapnWebRoot, useLiveState } from "iterate/sdk/capnweb/react";
import { Alert, AlertDescription, AlertTitle } from "@iterate-com/ui/components/alert";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Skeleton } from "@iterate-com/ui/components/skeleton";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { environments, type CompiledEnvironment } from "~/environments.ts";
import {
  MAX_ENVIRONMENT_DESTROY_BATCHES,
  type AlchemyResources,
  type EnvironmentApi,
  type EnvironmentLifecycle,
  type EnvironmentStage,
  type EnvironmentState,
} from "~/state.ts";

export const Route = createFileRoute("/_app/environments")({
  ssr: false,
  component: EnvironmentsPage,
  staticData: { breadcrumb: "Environments" },
});

function EnvironmentsPage() {
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Environments</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Each environment is one Alchemy data stack supervised by its own Durable Object. Wrangler
          deploys the application Workers; complete destroy removes those Workers and their Durable
          Object data before deleting the environment&apos;s D1, KV, and R2.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {environments.map((environment) => (
          <EnvironmentConnection key={environment.stage} environment={environment} />
        ))}
      </div>
    </section>
  );
}

function environmentWebSocketUrl(stage: string): string {
  const endpoint = new URL(`/api/environments/${stage}`, window.location.href);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return endpoint.toString();
}

async function destroyEnvironmentInBatches(stage: EnvironmentStage): Promise<void> {
  for (let batch = 1; batch <= MAX_ENVIRONMENT_DESTROY_BATCHES; batch += 1) {
    const api = newWebSocketRpcSession<EnvironmentApi>(environmentWebSocketUrl(stage));
    try {
      if (await api.destroy(stage)) return;
    } finally {
      api[Symbol.dispose]?.();
    }
  }
  throw new Error(
    `Destroying ${stage} did not converge after ${MAX_ENVIRONMENT_DESTROY_BATCHES} bounded batches; canonical Cloudflare inventory still contains resources.`,
  );
}

function EnvironmentConnection({ environment }: { environment: CompiledEnvironment }) {
  const makeConnection = useCallback(() => {
    return newWebSocketRpcSession<EnvironmentApi>(environmentWebSocketUrl(environment.stage));
  }, [environment.stage]);

  return (
    <CapnWebProvider makeConnection={makeConnection}>
      <EnvironmentCard environment={environment} />
    </CapnWebProvider>
  );
}

type PendingOperation = "check" | "deploy" | "destroy";

function EnvironmentCard({ environment }: { environment: CompiledEnvironment }) {
  const api = useCapnWebRoot<RpcStub<EnvironmentApi>>();
  const live = useLiveState(
    (session: RpcStub<EnvironmentApi>) => session.liveState,
    (state) => state,
  );
  const [pending, setPending] = useState<PendingOperation>();
  const [actionError, setActionError] = useState<string>();

  const state = live.value;
  const operating =
    pending !== undefined ||
    ((state?.lifecycle === "checking" ||
      state?.lifecycle === "deploying" ||
      state?.lifecycle === "destroying") &&
      state.operationFinishedAt === undefined);
  const error = actionError ?? live.error ?? state?.lastError;

  const run = async (operation: PendingOperation, action: () => Promise<void>) => {
    setActionError(undefined);
    setPending(operation);
    try {
      await action();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(undefined);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono">{environment.stage}</CardTitle>
        <CardDescription>
          {environment.kind === "platform" ? "Platform" : "Auth"} ·{" "}
          <a
            href={environment.baseUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
          >
            {new URL(environment.baseUrl).hostname}
            <ExternalLink className="size-3" />
          </a>
        </CardDescription>
        <CardAction>
          <LifecycleBadge lifecycle={state?.lifecycle} liveStatus={live.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Environment operation failed</AlertTitle>
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        ) : null}
        {state === undefined ? (
          <EnvironmentSkeleton />
        ) : (
          <>
            <ResourceSummary resources={state.resources} />
            <ProgressSummary state={state} />
          </>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          disabled={api === undefined || operating || state?.lifecycle === "destroying"}
          onClick={() => {
            if (api !== undefined) void run("deploy", () => api.deploy());
          }}
        >
          {pending === "deploy" ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <Rocket data-icon="inline-start" />
          )}
          Deploy
        </Button>
        <Button
          variant="outline"
          disabled={
            api === undefined ||
            operating ||
            state?.lifecycle === "destroying" ||
            state?.resources === undefined
          }
          onClick={() => {
            if (api !== undefined) void run("check", () => api.check());
          }}
        >
          {pending === "check" ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <HeartPulse data-icon="inline-start" />
          )}
          Check
        </Button>
        <Button
          variant="destructive"
          disabled={api === undefined || operating}
          onClick={() => {
            const confirmed =
              environment.stage === "prd"
                ? window.prompt("This permanently destroys production. Type prd to continue.") ===
                  "prd"
                : window.confirm(
                    `Completely destroy ${environment.stage}, including its Workers, Durable Object data, D1, KV, and R2?`,
                  );
            if (api !== undefined && confirmed) {
              void run("destroy", () => destroyEnvironmentInBatches(environment.stage));
            }
          }}
          className="ml-auto"
        >
          {pending === "destroy" ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <Trash2 data-icon="inline-start" />
          )}
          Destroy completely
        </Button>
      </CardFooter>
    </Card>
  );
}

function LifecycleBadge({
  lifecycle,
  liveStatus,
}: {
  lifecycle: EnvironmentLifecycle | undefined;
  liveStatus: string;
}) {
  if (liveStatus !== "live") {
    return <Badge variant="outline">{liveStatus}</Badge>;
  }

  const variant =
    lifecycle === "failed"
      ? "destructive"
      : lifecycle === "ready"
        ? "default"
        : lifecycle === "empty"
          ? "outline"
          : "secondary";
  return <Badge variant={variant}>{lifecycle ?? "connecting"}</Badge>;
}

function EnvironmentSkeleton() {
  return (
    <div className="space-y-3" aria-label="Loading environment state">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  );
}

function ResourceSummary({ resources }: { resources: AlchemyResources | undefined }) {
  if (resources === undefined) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        This environment has no provisioned Alchemy resources.
      </p>
    );
  }

  const rows =
    resources.kind === "auth"
      ? [["Auth D1", resources.authDbId]]
      : [
          ["Auth D1", resources.authDbId],
          ["Semaphore D1", resources.semaphoreDbId],
          ["Project KV", resources.projectDirectoryKvId],
          ["Build cache KV", resources.workerBuildCacheKvId],
          ["Files R2", resources.filesBucketName],
          ["Sandboxes R2", resources.sandboxesBucketName],
        ];

  return (
    <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-[auto_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="truncate font-mono" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ProgressSummary({ state }: { state: EnvironmentState }) {
  const latest = state.progress.slice(-4);
  if (latest.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No resource operation has run since this environment state was created.
      </p>
    );
  }

  return (
    <div className="space-y-2 border-t pt-3">
      {latest.map((progress) => (
        <div key={progress.id} className="flex items-start justify-between gap-3 text-xs">
          <span className="min-w-0 truncate font-mono">{progress.type}</span>
          <span className="shrink-0 text-muted-foreground">{progress.status}</span>
        </div>
      ))}
    </div>
  );
}
