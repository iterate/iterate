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
import { Separator } from "@iterate-com/ui/components/separator";
import { Skeleton } from "@iterate-com/ui/components/skeleton";
import { Spinner } from "@iterate-com/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { destroyEnvironmentInBatches } from "~/destroy-environment-client.ts";
import { environments, type CompiledEnvironment } from "~/environments.ts";
import {
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
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Environments</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Each environment is one Alchemy data stack supervised by its own Durable Object. Wrangler
          deploys the application Workers; complete destroy removes those Workers and their Durable
          Object data before deleting the environment&apos;s D1, KV, and R2.
        </p>
      </div>
      <div className="grid gap-4 2xl:grid-cols-2">
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

async function destroyEnvironmentFromDashboard(stage: EnvironmentStage): Promise<void> {
  await destroyEnvironmentInBatches({
    stage,
    connect: () => {
      const api = newWebSocketRpcSession<EnvironmentApi>(environmentWebSocketUrl(stage));
      return {
        api,
        close: () => api[Symbol.dispose]?.(),
      };
    },
  });
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
      <CardContent className="flex flex-col gap-5">
        {actionError ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Dashboard action failed</AlertTitle>
            <AlertDescription className="break-words">{actionError}</AlertDescription>
          </Alert>
        ) : null}
        {live.error ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Live connection failed</AlertTitle>
            <AlertDescription className="break-words">{live.error}</AlertDescription>
          </Alert>
        ) : null}
        {state?.lastError ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Last environment operation failed</AlertTitle>
            <AlertDescription className="break-words">{state.lastError}</AlertDescription>
          </Alert>
        ) : null}
        {state === undefined ? (
          <EnvironmentSkeleton />
        ) : (
          <>
            <DestroyStatus state={state} />
            <EnvironmentDetails
              environment={environment}
              state={state}
              liveStatus={live.status}
              dashboardRequest={pending}
            />
            <Separator />
            <ResourceSummary resources={state.resources} />
            <Separator />
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
              void run("destroy", () => destroyEnvironmentFromDashboard(environment.stage));
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
    <div className="flex flex-col gap-3" aria-label="Loading environment state">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  );
}

function DestroyStatus({ state }: { state: EnvironmentState }) {
  if (state.lifecycle !== "destroying") return null;

  const batchFinished = state.operationFinishedAt !== undefined;
  return (
    <Alert>
      <Trash2 />
      <AlertTitle>
        {batchFinished
          ? "Cleanup remains after this destroy batch"
          : "Complete destroy in progress"}
      </AlertTitle>
      <AlertDescription>
        {batchFinished
          ? "Resume Destroy completely to run the next bounded batch. Deploy and check remain blocked until the canonical Alchemy output is empty."
          : "Deploy and check are blocked while this bounded batch runs. Preview automation keeps its Semaphore lease fenced until environment-manager reports an empty stack."}
      </AlertDescription>
    </Alert>
  );
}

function EnvironmentDetails({
  environment,
  state,
  liveStatus,
  dashboardRequest,
}: {
  environment: CompiledEnvironment;
  state: EnvironmentState;
  liveStatus: string;
  dashboardRequest: PendingOperation | undefined;
}) {
  const startedAt = state.operationStartedAt && Date.parse(state.operationStartedAt);
  const finishedAt = state.operationFinishedAt && Date.parse(state.operationFinishedAt);
  const duration =
    typeof startedAt === "number" &&
    Number.isFinite(startedAt) &&
    typeof finishedAt === "number" &&
    Number.isFinite(finishedAt)
      ? `${(finishedAt - startedAt).toLocaleString()}ms`
      : state.operationStartedAt !== undefined && state.operationFinishedAt === undefined
        ? "In progress"
        : "Not recorded";
  const inventory = [
    ["Stage", environment.stage],
    ["Kind", environment.kind],
    ["Cloudflare account", environment.account],
    ["Account ID", environment.accountId],
    ["Base URL", environment.baseUrl],
    ...(environment.kind === "platform" ? [["OS Worker", environment.osWorkerName]] : []),
    [
      `Managed Workers (${environment.workerNames.length.toLocaleString()})`,
      environment.workerNames.join("\n"),
    ],
  ];
  const operation = [
    ["State stage", state.stage],
    ["Connection", liveStatus],
    ["Dashboard request", dashboardRequest ?? "Idle"],
    ["Lifecycle", state.lifecycle],
    ["Operation ID", state.operationId ?? "Not recorded"],
    ["Started", state.operationStartedAt ?? "Not recorded"],
    ["Finished", state.operationFinishedAt ?? "Not recorded"],
    ["Duration", duration],
    ["Progress records", state.progress.length.toLocaleString()],
    ["Last error", state.lastError ?? "None"],
  ];

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <DetailList
        title="Compiled inventory"
        description="Non-secret deployment topology from envs.ts"
        rows={inventory}
      />
      <DetailList
        title="Durable Object state"
        description="Canonical lifecycle state streamed over Cap'n Web"
        rows={operation}
      />
    </div>
  );
}

function DetailList({
  title,
  description,
  rows,
}: {
  title: string;
  description: string;
  rows: string[][];
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-[auto_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-all font-mono whitespace-pre-wrap">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ResourceSummary({ resources }: { resources: AlchemyResources | undefined }) {
  if (resources === undefined) {
    return (
      <DetailList
        title="Alchemy output"
        description="Canonical resource manifest read directly from the Alchemy state store"
        rows={[["Resources", "No D1, KV, or R2 identifiers are provisioned"]]}
      />
    );
  }

  const rows =
    resources.kind === "auth"
      ? [
          ["Output kind", resources.kind],
          ["Output stage", resources.stage],
          ["Auth D1", resources.authDbId],
        ]
      : [
          ["Output kind", resources.kind],
          ["Output stage", resources.stage],
          ["Auth D1", resources.authDbId],
          ["Semaphore D1", resources.semaphoreDbId],
          ["Project KV", resources.projectDirectoryKvId],
          ["Build cache KV", resources.workerBuildCacheKvId],
          ["Files R2", resources.filesBucketName],
          ["Sandboxes R2", resources.sandboxesBucketName],
        ];

  return (
    <DetailList
      title="Alchemy output"
      description="Canonical resource manifest read directly from the Alchemy state store"
      rows={rows}
    />
  );
}

function ProgressSummary({ state }: { state: EnvironmentState }) {
  if (state.progress.length === 0) {
    return (
      <DetailList
        title="Operation progress"
        description="Every record published by the current or most recent operation"
        rows={[["Records", "No resource operation has published progress"]]}
      />
    );
  }

  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label="Operation progress">
      <div>
        <h3 className="text-sm font-medium">Operation progress</h3>
        <p className="text-xs text-muted-foreground">
          Every progress record published by the current or most recent operation
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Resource</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Detail</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.progress.map((progress) => (
            <TableRow key={progress.id} className="hover:bg-transparent">
              <TableCell className="w-48 py-2 align-top whitespace-normal">
                <div className="flex flex-col gap-0.5">
                  <span className="break-all font-mono text-xs font-medium">{progress.type}</span>
                  <span className="break-all font-mono text-xs text-muted-foreground">
                    {progress.id}
                  </span>
                </div>
              </TableCell>
              <TableCell className="w-24 py-2 align-top">
                <Badge variant="outline">{progress.status}</Badge>
              </TableCell>
              <TableCell className="py-2 align-top text-xs whitespace-normal text-muted-foreground">
                {progress.message ?? "No detail message"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
