import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { FindResourceInput, type SemaphoreResourceRecord } from "@iterate-com/semaphore-contract";
import { findResourceByKey } from "~/lib/resource-store.ts";

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

const loadResource = createServerFn({ method: "GET" })
  .inputValidator(FindResourceInput)
  .handler(async ({ context, data }) => {
    const resource = await findResourceByKey(context.db, data);
    if (!resource) {
      throw new Error(`No resource exists for ${data.type}/${data.slug}.`);
    }

    return serializeResource(resource);
  });

export const Route = createFileRoute("/_app/resources/$type/$slug")({
  component: ResourceDetailPage,
  loader: async ({ params }) => ({
    breadcrumb: `${params.type}/${params.slug}`,
    resource: await loadResource({ data: params }),
  }),
});

function ResourceDetailPage() {
  const { resource: data } = Route.useLoaderData();

  return (
    <section className="space-y-4">
      <div className="rounded-lg border bg-card p-4">
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Type</dt>
            <dd className="mt-1">{data.type}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Slug</dt>
            <dd className="mt-1">{data.slug}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Lease state</dt>
            <dd className="mt-1">{data.leaseState}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Leased until</dt>
            <dd className="mt-1">
              {data.leasedUntil ? new Date(data.leasedUntil).toISOString() : "Not leased"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Created</dt>
            <dd className="mt-1">{data.createdAt}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Updated</dt>
            <dd className="mt-1">{data.updatedAt}</dd>
          </div>
        </dl>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">Data</p>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
          {JSON.stringify(data.data, null, 2)}
        </pre>
      </div>
    </section>
  );
}
