import { useCallback, useState } from "react";
import type { PublicAppConfig } from "@iterate-com/shared/apps/config";
import { useConfig } from "@iterate-com/ui/apps/config";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { toast } from "@iterate-com/ui/components/sonner";
import type { AppConfig } from "~/app.ts";
import { orpc, orpcClient } from "~/orpc/client.ts";

type PublicConfig = PublicAppConfig<AppConfig>;

export const Route = createFileRoute("/_app/debug")({
  staticData: {
    breadcrumb: "Debug",
  },
  loader: async () => ({
    ping: await orpcClient.ping({}),
  }),
  component: DebugPage,
});

function DebugPage() {
  const publicConfig = useConfig<PublicConfig>();
  const { ping } = Route.useLoaderData();
  const [showPirateSecret, setShowPirateSecret] = useState(false);
  const { data: pirateSecretData, isPending: pirateSecretPending } = useQuery({
    ...orpc.pirateSecret.queryOptions({ input: {} }),
    enabled: showPirateSecret,
  });
  const [demoBusy, setDemoBusy] = useState(false);
  const [lastLogDemo, setLastLogDemo] = useState<{
    label: string;
    requestId: string;
    steps: string[];
  } | null>(null);
  const [lastServerError, setLastServerError] = useState<string | null>(null);

  const handleBrowserThrow = useCallback(() => {
    console.log("[os] browser throw button pressed");
    throw new Error("OS browser test exception");
  }, []);

  const handleServerLogDemo = useCallback(async () => {
    console.log("[os] rich server log demo button pressed");
    setDemoBusy(true);
    setLastServerError(null);
    try {
      const request = orpcClient.test.logDemo({ label: "frontend-rich-log-demo" });
      toast.promise(request, {
        loading: "Running rich server log demo...",
        success: (result) => `Logged ${result.steps.length} server steps`,
        error: "Rich server log demo failed",
      });
      const result = await request;
      console.log("[os] rich server log demo result", result);
      setLastLogDemo(result);
    } finally {
      setDemoBusy(false);
    }
  }, []);

  const handleServerThrow = useCallback(async () => {
    console.log("[os] server throw button pressed");
    setDemoBusy(true);
    try {
      const request = orpcClient.test.serverThrow({
        message: "OS server test exception from the frontend button",
      });
      toast.promise(request, {
        loading: "Triggering server exception...",
        success: "Server exception demo unexpectedly succeeded",
        error: "Server exception surfaced to the client",
      });
      await request;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[os] server throw produced client-visible error", error);
      setLastServerError(message);
    } finally {
      setDemoBusy(false);
    }
  }, []);

  return (
    <div className="space-y-8 p-4">
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Runtime deps demo</h2>
          <p className="text-sm text-muted-foreground">
            The terminal route uses a runtime-injected PTY dep in Node and a not-implemented
            fallback in Cloudflare.
          </p>
        </div>
        <Button size="sm" nativeButton={false} render={<Link to="/terminal" />}>
          Open web terminal
        </Button>
      </section>

      <section className="space-y-1">
        <h2 className="text-sm font-semibold">oRPC Ping</h2>
        <p className="text-sm text-muted-foreground">{`${ping.message} @ ${ping.serverTime}`}</p>
      </section>

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Public Config</h2>
          <p className="text-sm text-muted-foreground">
            This is the SSR-loaded public app config from the root route.
          </p>
        </div>
        <pre className="overflow-x-auto rounded-md border p-3 font-mono text-sm">
          {JSON.stringify(publicConfig, null, 2)}
        </pre>
      </section>

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Pirate Secret</h2>
          <p className="text-sm text-muted-foreground">
            Fetch a secret from the server-side env contract.
          </p>
        </div>
        {!showPirateSecret ? (
          <Button size="sm" onClick={() => setShowPirateSecret(true)}>
            Reveal Pirate Secret
          </Button>
        ) : pirateSecretPending ? (
          <p className="text-sm text-muted-foreground">Loading secret...</p>
        ) : (
          <p className="rounded-md border p-3 font-mono text-sm">{pirateSecretData?.secret}</p>
        )}
      </section>

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Toast / Sonner demo</h2>
          <p className="text-sm text-muted-foreground">
            These use the shared toaster rendered by the root route&apos;s <code>AppProviders</code>
            .
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              toast.info("OS info toast", {
                description:
                  "The shared AppProviders wrapper is rendering the toaster for this page.",
              })
            }
          >
            Show info toast
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              toast.success("OS success toast", {
                description: "This is the shared sonner styling from packages/ui.",
              })
            }
          >
            Show success toast
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void toast.promise(
                new Promise((resolve) => {
                  setTimeout(resolve, 1500);
                }),
                {
                  loading: "Waiting 1.5 seconds...",
                  success: "Loading toast finished",
                  error: "The loading toast failed",
                },
              )
            }
          >
            Show loading toast
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Observability / failure demo</h2>
          <p className="text-sm text-muted-foreground">
            Use these buttons to test browser exceptions, mixed info/warn/error request logs on the
            server, and server-side exception reporting.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="destructive" onClick={handleBrowserThrow}>
            Throw in browser
          </Button>
          <Button size="sm" disabled={demoBusy} onClick={() => void handleServerLogDemo()}>
            Run rich server log demo
          </Button>
          <Button size="sm" disabled={demoBusy} onClick={() => void handleServerThrow()}>
            Throw on server
          </Button>
        </div>
        {lastLogDemo && (
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">Last rich server log demo</p>
            <p className="text-muted-foreground">requestId: {lastLogDemo.requestId}</p>
            <p className="text-muted-foreground">label: {lastLogDemo.label}</p>
            <p className="text-muted-foreground">steps: {lastLogDemo.steps.join(" -> ")}</p>
          </div>
        )}
        {lastServerError && (
          <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
            Last server error seen by client: {lastServerError}
          </div>
        )}
      </section>
    </div>
  );
}
