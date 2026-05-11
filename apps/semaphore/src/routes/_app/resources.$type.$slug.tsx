import { useEffect, useState, useTransition } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  FindResourceInput,
  type SemaphoreLeaseRecord,
  type SemaphoreResourceRecord,
} from "@iterate-com/semaphore-contract";
import { toast } from "@iterate-com/ui/components/sonner";
import { z } from "zod";
import { findResourceByKey } from "~/lib/resource-store.ts";

const operatorTokenStorageKey = "semaphore-operator-token";
const defaultLeaseMs = 10 * 60 * 1000;

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

const mutateResourceLease = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      action: z.enum(["acquire", "release"]),
      type: z.string().trim().min(1),
      slug: z.string().trim().min(1),
      operatorToken: z.string().trim().min(1),
      leaseMs: z.coerce.number().int().positive().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    if (data.operatorToken !== context.config.sharedApiSecret.exposeSecret()) {
      throw new Error("Missing or invalid operator token.");
    }

    const coordinator = context.env.RESOURCE_COORDINATOR.getByName(data.type);
    const currentLease = await coordinator.getLease({
      type: data.type,
      slug: data.slug,
    });

    if (data.action === "acquire") {
      if (currentLease) {
        return {
          action: data.action,
          changed: false,
          message: "Resource is already leased.",
        };
      }

      const acquiredLease = await coordinator.acquireSpecific({
        type: data.type,
        slug: data.slug,
        leaseMs: data.leaseMs ?? defaultLeaseMs,
      });
      if (!acquiredLease) {
        throw new Error("Resource is not available for acquire.");
      }
      const resolvedAcquiredLease = acquiredLease as SemaphoreLeaseRecord;

      return {
        action: data.action,
        changed: true,
        message: `Leased until ${new Date(resolvedAcquiredLease.expiresAt).toISOString()}.`,
      };
    }

    if (!currentLease) {
      return {
        action: data.action,
        changed: false,
        message: "Resource is already available.",
      };
    }

    const released = await coordinator.release({
      type: data.type,
      slug: data.slug,
      leaseId: currentLease.leaseId,
    });
    if (!released) {
      throw new Error("Failed to release resource.");
    }

    return {
      action: data.action,
      changed: true,
      message: "Resource released.",
    };
  });

export const Route = createFileRoute("/_app/resources/$type/$slug")({
  component: ResourceDetailPage,
  loader: async ({ params }) => ({
    breadcrumb: `${params.type}/${params.slug}`,
    resource: await loadResource({ data: params }),
  }),
});

function ResourceDetailPage() {
  const router = useRouter();
  const { resource } = Route.useLoaderData();
  const [operatorToken, setOperatorToken] = useState("");
  const [leaseMs, setLeaseMs] = useState(String(defaultLeaseMs));
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setOperatorToken(window.localStorage.getItem(operatorTokenStorageKey) ?? "");
  }, []);

  useEffect(() => {
    if (operatorToken) {
      window.localStorage.setItem(operatorTokenStorageKey, operatorToken);
      return;
    }

    window.localStorage.removeItem(operatorTokenStorageKey);
  }, [operatorToken]);

  function runResourceLeaseAction(action: "acquire" | "release") {
    startTransition(async () => {
      try {
        const result = await mutateResourceLease({
          data: {
            action,
            type: resource.type,
            slug: resource.slug,
            operatorToken,
            leaseMs: Number(leaseMs),
          },
        });

        toast.success(result.message);
        await router.invalidate();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    });
  }

  return (
    <section className="space-y-4">
      <div className="rounded-lg border bg-card p-4">
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Type</dt>
            <dd className="mt-1">{resource.type}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Slug</dt>
            <dd className="mt-1">{resource.slug}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Lease state</dt>
            <dd className="mt-1">{resource.leaseState}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Leased until</dt>
            <dd className="mt-1">
              {resource.leasedUntil ? new Date(resource.leasedUntil).toISOString() : "Not leased"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Created</dt>
            <dd className="mt-1">{resource.createdAt}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Updated</dt>
            <dd className="mt-1">{resource.updatedAt}</dd>
          </div>
        </dl>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="mb-4 space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Operator Actions</p>
          <p className="text-sm text-muted-foreground">
            Paste the shared API token to acquire or release resources from the UI.
          </p>
        </div>

        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Operator token
            </span>
            <input
              type="password"
              value={operatorToken}
              onChange={(event) => setOperatorToken(event.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="Paste APP_CONFIG_SHARED_API_SECRET"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Lease duration (ms)
            </span>
            <input
              type="number"
              min={1}
              value={leaseMs}
              onChange={(event) => setLeaseMs(event.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </label>

          <div className="flex gap-3">
            <button
              type="button"
              disabled={isPending || operatorToken.length === 0}
              onClick={() => runResourceLeaseAction("acquire")}
              className="rounded-md border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              Acquire
            </button>
            <button
              type="button"
              disabled={isPending || operatorToken.length === 0}
              onClick={() => runResourceLeaseAction("release")}
              className="rounded-md border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              Release
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">Data</p>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
          {JSON.stringify(resource.data, null, 2)}
        </pre>
      </div>
    </section>
  );
}
