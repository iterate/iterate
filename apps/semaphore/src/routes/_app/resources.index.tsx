import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type {
  PreviewEnvironmentRecord,
  SemaphoreResourceRecord,
} from "@iterate-com/semaphore-contract";
import { listPreviewEnvironmentRecords } from "~/lib/preview-environments.ts";
import { listResourcesFromDb } from "~/lib/resource-store.ts";

type SerializableJsonValue =
  | boolean
  | null
  | number
  | string
  | SerializableJsonValue[]
  | { [key: string]: SerializableJsonValue };

type SerializableSemaphoreResource = Omit<SemaphoreResourceRecord, "data"> & {
  data: Record<string, SerializableJsonValue>;
  previewEnvironment: PreviewEnvironmentRecord | null;
};

function toSerializableJsonValue(value: unknown): SerializableJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(toSerializableJsonValue);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, toSerializableJsonValue(entryValue)]),
    );
  }

  throw new Error("Semaphore resource data must be JSON-serializable");
}

function serializeResource(
  resource: SemaphoreResourceRecord,
  previewEnvironment: PreviewEnvironmentRecord | null,
): SerializableSemaphoreResource {
  return {
    ...resource,
    data: Object.fromEntries(
      Object.entries(resource.data).map(([key, value]) => [key, toSerializableJsonValue(value)]),
    ),
    previewEnvironment,
  };
}

const loadResources = createServerFn({ method: "GET" }).handler(async ({ context }) => {
  const resources = await listResourcesFromDb(context.db);
  const previewEnvironments = await listPreviewEnvironmentRecords(context, {});
  const previewEnvironmentByIdentifier = new Map(
    previewEnvironments.map((previewEnvironment) => [
      previewEnvironment.previewEnvironmentIdentifier,
      previewEnvironment,
    ]),
  );

  return resources.map((resource) =>
    serializeResource(resource, previewEnvironmentByIdentifier.get(resource.slug) ?? null),
  );
});

const loadRequestHost = createServerFn({ method: "GET" }).handler(async ({ context }) => {
  return context.rawRequest?.headers.get("host") ?? "";
});

export const Route = createFileRoute("/_app/resources/")({
  loader: async () => ({
    requestHost: await loadRequestHost(),
    resources: await loadResources(),
  }),
  component: ResourcesIndexPage,
  staticData: {
    breadcrumb: "All",
  },
});

function ResourcesIndexPage() {
  const { requestHost, resources: data } = Route.useLoaderData();
  const groupedResources = data.reduce((groups, resource) => {
    const group = groups.get(resource.type) ?? [];
    group.push(resource);
    groups.set(resource.type, group);
    return groups;
  }, new Map<string, SerializableSemaphoreResource[]>());

  return (
    <section className="space-y-4">
      <PreviewBanner requestHost={requestHost} />

      <p className="text-sm text-muted-foreground">
        Public dashboard view backed by server-side reads. The `/api/resources*` endpoints require
        the bearer token.
      </p>

      <div className="space-y-6">
        {Array.from(groupedResources.entries()).map(([type, resources]) => {
          const leasedCount = resources.filter(
            (resource) => resource.leaseState === "leased",
          ).length;

          return (
            <section key={type} className="space-y-3">
              <div className="space-y-1">
                <p className="font-medium">{formatResourceTypeLabel(type)}</p>
                <p className="text-xs text-muted-foreground">
                  {leasedCount} leased · {resources.length - leasedCount} available
                </p>
              </div>

              <div className="space-y-3">
                {resources.map((resource) => (
                  <a
                    key={`${resource.type}:${resource.slug}`}
                    href={`/resources/${encodeURIComponent(resource.type)}/${encodeURIComponent(resource.slug)}/`}
                    className="block rounded-lg border bg-card p-4 transition-colors hover:border-foreground/30"
                  >
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {resource.previewEnvironment?.previewEnvironmentIdentifier ??
                              resource.slug}
                          </p>
                          <p className="truncate text-sm text-muted-foreground">{resource.type}</p>
                        </div>
                        <div className="shrink-0 text-xs text-muted-foreground">
                          {resource.leaseState}
                        </div>
                      </div>

                      {resource.previewEnvironment ? (
                        <div className="space-y-1 text-xs text-muted-foreground">
                          <p>{resource.previewEnvironment.previewEnvironmentWorkersDevHostname}</p>
                          <p>
                            {resource.previewEnvironment.previewEnvironmentDopplerConfigName} ·{" "}
                            {resource.previewEnvironment.previewEnvironmentAlchemyStageName}
                          </p>
                          {resource.previewEnvironment.previewEnvironmentLeaseOwner ? (
                            <p>
                              PR #
                              {
                                resource.previewEnvironment.previewEnvironmentLeaseOwner
                                  .pullRequestNumber
                              }{" "}
                              ·{" "}
                              {
                                resource.previewEnvironment.previewEnvironmentLeaseOwner
                                  .pullRequestHeadRefName
                              }{" "}
                              ·{" "}
                              {resource.previewEnvironment.previewEnvironmentLeaseOwner.pullRequestHeadSha.slice(
                                0,
                                7,
                              )}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {Object.keys(resource.data).length} data field
                          {Object.keys(resource.data).length === 1 ? "" : "s"}
                        </p>
                      )}

                      <p className="text-xs text-muted-foreground">
                        {resource.leasedUntil
                          ? `leased until ${new Date(resource.leasedUntil).toISOString()}`
                          : "available now"}
                      </p>
                    </div>
                  </a>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {data.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          No resources are currently registered.
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
      className: "border-fuchsia-500/40 bg-fuchsia-50 text-fuchsia-950",
      title: "Semaphore Preview One",
      description: "Fuchsia operator panel for the first claimed semaphore preview.",
    };
  }

  if (slotNumber === 2) {
    return {
      className: "border-indigo-500/40 bg-indigo-50 text-indigo-950",
      title: "Semaphore Preview Two",
      description: "Indigo operator panel for the second claimed semaphore preview.",
    };
  }

  if (slotNumber === 3) {
    return {
      className: "border-emerald-500/40 bg-emerald-50 text-emerald-950",
      title: "Semaphore Preview Three",
      description: "Emerald operator panel for the third claimed semaphore preview.",
    };
  }

  return {
    className: "border-neutral-300 bg-card text-foreground",
    title: "Semaphore Inventory",
    description: "Public inventory dashboard for shared resource leasing.",
  };
}

function formatResourceTypeLabel(type: string) {
  if (type.endsWith("-preview-environment")) {
    return `${type.replace(/-preview-environment$/, "").replace(/-/g, " ")} preview environments`;
  }

  return type;
}
