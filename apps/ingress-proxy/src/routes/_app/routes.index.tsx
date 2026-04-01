import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { orpc } from "~/orpc/client.ts";

const loadRequestHost = createServerFn({ method: "GET" }).handler(async ({ context }) => {
  return context.rawRequest?.headers.get("host") ?? "";
});

export const Route = createFileRoute("/_app/routes/")({
  loader: async () => ({
    requestHost: await loadRequestHost(),
  }),
  component: RoutesIndexPage,
  staticData: {
    breadcrumb: "All",
  },
});

function RoutesIndexPage() {
  const { requestHost } = Route.useLoaderData();
  const { data } = useQuery({
    ...orpc.routes.list.queryOptions({ input: { limit: 100, offset: 0 } }),
    staleTime: 15_000,
  });

  return (
    <section className="space-y-4">
      <PreviewBanner requestHost={requestHost} />

      <p className="text-sm text-muted-foreground">
        Public read-only view of the current ingress registry. Mutations stay behind the bearer
        token, but listing and inspection are intentionally open here.
      </p>

      <div className="space-y-3">
        {data?.routes.map((route) => (
          <a
            key={route.id}
            href={`/routes/${encodeURIComponent(route.rootHost)}/`}
            className="block rounded-lg border bg-card p-4 transition-colors hover:border-foreground/30"
          >
            <div className="space-y-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{route.rootHost}</p>
                <p className="truncate text-sm text-muted-foreground">{route.targetUrl}</p>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{route.id}</span>
                <span>{Object.keys(route.metadata).length} metadata fields</span>
              </div>
            </div>
          </a>
        ))}
      </div>

      {data && data.routes.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          No ingress routes are currently registered.
        </p>
      ) : null}
    </section>
  );
}

function PreviewBanner(props: { requestHost: string }) {
  const banner = resolvePreviewBanner(props.requestHost);

  return (
    <section className={`rounded-xl border px-4 py-3 ${banner.className}`}>
      <p className="text-sm font-semibold">{banner.title}</p>
      <p className="text-sm opacity-80">{banner.description}</p>
      <p className="mt-1 font-mono text-xs opacity-70">{props.requestHost}</p>
    </section>
  );
}

function resolvePreviewBanner(requestHost: string) {
  const slotNumber = Number(/^.+-preview-(\d+)(?:\..+)?$/.exec(requestHost)?.[1] ?? "0");

  if (slotNumber === 1) {
    return {
      className: "border-orange-500/40 bg-orange-50 text-orange-950",
      title: "Ingress Preview One",
      description: "Orange control-surface variant for the first ingress preview.",
    };
  }

  if (slotNumber === 2) {
    return {
      className: "border-violet-500/40 bg-violet-50 text-violet-950",
      title: "Ingress Preview Two",
      description: "Violet control-surface variant for the second ingress preview.",
    };
  }

  if (slotNumber === 3) {
    return {
      className: "border-teal-500/40 bg-teal-50 text-teal-950",
      title: "Ingress Preview Three",
      description: "Teal control-surface variant for the third ingress preview.",
    };
  }

  return {
    className: "border-neutral-300 bg-card text-foreground",
    title: "Ingress Registry",
    description: "Open inspection view of registered ingress routes.",
  };
}
