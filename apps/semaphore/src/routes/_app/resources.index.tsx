import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type { SemaphoreResourceRecord } from "@iterate-com/semaphore-contract";
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

function serializeResource(resource: SemaphoreResourceRecord): SerializableSemaphoreResource {
  return {
    ...resource,
    data: Object.fromEntries(
      Object.entries(resource.data).map(([key, value]) => [key, toSerializableJsonValue(value)]),
    ),
  };
}

const loadResources = createServerFn({ method: "GET" }).handler(async ({ context }) => {
  const resources = await listResourcesFromDb(context.db);
  return resources.map(serializeResource);
});

export const Route = createFileRoute("/_app/resources/")({
  loader: () => loadResources(),
  component: ResourcesIndexPage,
  staticData: {
    breadcrumb: "All",
  },
});

function ResourcesIndexPage() {
  const data = Route.useLoaderData();

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Public dashboard view backed by server-side reads. The `/api/resources*` endpoints require
        the bearer token.
      </p>

      <div className="space-y-3">
        {data.map((resource) => (
          <a
            key={`${resource.type}:${resource.slug}`}
            href={`/resources/${encodeURIComponent(resource.type)}/${encodeURIComponent(resource.slug)}/`}
            className="block rounded-lg border bg-card p-4 transition-colors hover:border-foreground/30"
          >
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate font-medium">{resource.slug}</p>
                  <p className="truncate text-sm text-muted-foreground">{resource.type}</p>
                </div>
                <div className="shrink-0 text-xs text-muted-foreground">{resource.leaseState}</div>
              </div>
              <p className="text-xs text-muted-foreground">
                {resource.leasedUntil
                  ? `leased until ${new Date(resource.leasedUntil).toISOString()}`
                  : "available now"}
              </p>
            </div>
          </a>
        ))}
      </div>

      {data.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          No resources are currently registered.
        </p>
      ) : null}
    </section>
  );
}
