import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { getOrpcClient } from "~/orpc/client.ts";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const helloMutation = useMutation({
    mutationFn: () => getOrpcClient().hello({ name: "world" }),
  });

  const [streamPath, setStreamPath] = useState("/");
  const [publicBaseUrl, setPublicBaseUrl] = useState(() =>
    typeof window === "undefined" ? "" : window.location.origin,
  );
  const [projectSlug, setProjectSlug] = useState("public");
  const subscribeMutation = useMutation({
    mutationFn: (args: { streamPath: string; publicBaseUrl: string; projectSlug: string }) =>
      getOrpcClient().subscribeStream(args),
  });

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 p-4">
      <div className="space-y-1">
        <p className="text-xl font-semibold">hello world</p>
        <p className="text-sm text-muted-foreground">
          Tiny agents app with the shared PostHog and oRPC plumbing still wired up.
        </p>
      </div>

      <section className="space-y-3">
        <div className="space-y-1">
          <p className="text-sm font-semibold">Sample procedure</p>
          <p className="text-xs text-muted-foreground">Round-trips the `hello` oRPC call.</p>
        </div>

        <button
          type="button"
          className="inline-flex w-fit items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          disabled={helloMutation.isPending}
          onClick={() => helloMutation.mutate()}
        >
          {helloMutation.isPending ? "Calling..." : "Call sample procedure"}
        </button>

        {helloMutation.data ? (
          <p data-testid="hello-result" className="text-sm">
            {helloMutation.data.message}
          </p>
        ) : null}

        {helloMutation.error ? (
          <p role="alert" className="text-sm text-destructive">
            {helloMutation.error.message}
          </p>
        ) : null}
      </section>

      <section className="space-y-3 border-t pt-6">
        <div className="space-y-1">
          <p className="text-sm font-semibold">Subscribe a stream</p>
          <p className="text-xs text-muted-foreground">
            Appends a <code>stream/subscription/configured</code> event to the given
            events.iterate.com stream pointing at a <code>wss://</code> callback built from the
            public base URL below. The base URL defaults to this page&apos;s origin — if you&apos;re
            viewing this via your tunnel, it&apos;ll just work.
          </p>
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const resolved = resolveSubscribeInputs({
              streamPath,
              publicBaseUrl,
              projectSlug,
              appendRandomChild: false,
            });
            if (!resolved) return;
            subscribeMutation.mutate(resolved);
          }}
        >
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" htmlFor="subscribe-public-base-url">
              Public base URL
            </label>
            <input
              id="subscribe-public-base-url"
              type="url"
              autoComplete="off"
              placeholder="https://your-tunnel.example.com"
              value={publicBaseUrl}
              onChange={(event) => setPublicBaseUrl(event.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" htmlFor="subscribe-project-slug">
              Project slug
            </label>
            <input
              id="subscribe-project-slug"
              type="text"
              autoComplete="off"
              placeholder="public"
              value={projectSlug}
              onChange={(event) => setProjectSlug(event.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" htmlFor="subscribe-stream-path">
              Stream path
            </label>
            <input
              id="subscribe-stream-path"
              type="text"
              autoComplete="off"
              placeholder="/my/stream"
              value={streamPath}
              onChange={(event) => setStreamPath(event.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className="inline-flex w-fit items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              disabled={
                subscribeMutation.isPending ||
                streamPath.trim().length === 0 ||
                publicBaseUrl.trim().length === 0 ||
                projectSlug.trim().length === 0
              }
            >
              {subscribeMutation.isPending ? "Subscribing..." : "Subscribe"}
            </button>

            <button
              type="button"
              className="inline-flex w-fit items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              title="Append a random segment to the stream path and subscribe to that child"
              disabled={
                subscribeMutation.isPending ||
                streamPath.trim().length === 0 ||
                publicBaseUrl.trim().length === 0 ||
                projectSlug.trim().length === 0
              }
              onClick={() => {
                const resolved = resolveSubscribeInputs({
                  streamPath,
                  publicBaseUrl,
                  projectSlug,
                  appendRandomChild: true,
                });
                if (!resolved) return;
                subscribeMutation.mutate(resolved);
              }}
            >
              {subscribeMutation.isPending ? "Subscribing..." : "Subscribe random child"}
            </button>
          </div>
        </form>

        {subscribeMutation.data ? (
          <dl
            data-testid="subscribe-result"
            className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border bg-card p-3 text-xs"
          >
            <dt className="font-medium text-muted-foreground">Stream</dt>
            <dd className="break-all">
              <a
                href={subscribeMutation.data.streamViewerUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                {subscribeMutation.data.streamPath}
              </a>
            </dd>

            <dt className="font-medium text-muted-foreground">Viewer</dt>
            <dd className="break-all">
              <a
                href={subscribeMutation.data.streamViewerUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                {subscribeMutation.data.streamViewerUrl}
              </a>
            </dd>

            <dt className="font-medium text-muted-foreground">Callback</dt>
            <dd className="break-all font-mono">{subscribeMutation.data.callbackUrl}</dd>

            <dt className="font-medium text-muted-foreground">Append URL</dt>
            <dd className="break-all font-mono">{subscribeMutation.data.appendUrl}</dd>

            <dt className="font-medium text-muted-foreground">Instance</dt>
            <dd className="break-all font-mono">{subscribeMutation.data.agentInstance}</dd>

            <dt className="font-medium text-muted-foreground">Subscription slug</dt>
            <dd className="break-all font-mono">{subscribeMutation.data.subscriptionSlug}</dd>
          </dl>
        ) : null}

        {subscribeMutation.error ? (
          <p role="alert" className="text-sm text-destructive">
            {subscribeMutation.error.message}
          </p>
        ) : null}
      </section>
    </main>
  );
}

function resolveSubscribeInputs(args: {
  streamPath: string;
  publicBaseUrl: string;
  projectSlug: string;
  appendRandomChild: boolean;
}): { streamPath: string; publicBaseUrl: string; projectSlug: string } | null {
  const trimmedPath = args.streamPath.trim();
  const trimmedBase = args.publicBaseUrl.trim();
  const trimmedProject = args.projectSlug.trim();
  if (trimmedPath.length === 0 || trimmedBase.length === 0 || trimmedProject.length === 0) {
    return null;
  }
  const withLeadingSlash = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "") || "/";
  const finalPath = args.appendRandomChild
    ? appendRandomSegment(withoutTrailingSlash)
    : withLeadingSlash;
  return {
    streamPath: finalPath,
    publicBaseUrl: trimmedBase,
    projectSlug: trimmedProject,
  };
}

function appendRandomSegment(prefix: string): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const slug = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return prefix === "/" ? `/${slug}` : `${prefix}/${slug}`;
}
