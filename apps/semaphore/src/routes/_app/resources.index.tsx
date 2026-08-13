import { useEffect, useTransition } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { toast } from "@iterate-com/ui/components/sonner";
import { z } from "zod";
import type { SemaphoreResourceRecord } from "~/contract.ts";
import { requireAdminPrincipal } from "~/lib/require-admin.ts";
import { listResourcesFromDb } from "~/lib/resource-store.ts";

/**
 * The resource type holding the PR preview slots (see the repo-root
 * scripts/preview tooling, which owns this inventory). Slugs follow the
 * `preview-N` convention, from which each slot's deployed app hostnames
 * derive — same convention as the root envs.ts.
 */
const ENVIRONMENT_CONFIG_LEASE_TYPE = "environment-config-lease";

const DASHBOARD_REFRESH_MS = 30_000;

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
    // oxlint-disable-next-line iterate/simple-truthiness-check -- JSON has null but no undefined; truthiness would let undefined through
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
  requireAdminPrincipal(context);
  const resources = await listResourcesFromDb(context.db);
  return resources.map(serializeResource);
});

// Matches the PR preview flow's lease length (scripts/preview: a slot belongs
// to its PR for the PR's life; expiry is the abandoned-PR safety valve).
const CLAIM_LEASE_MS = 24 * 60 * 60 * 1000;

/**
 * Operator lease actions from the dashboard. Claiming records the holder on
 * the lease (like `pnpm preview acquire`) — it does not deploy anything;
 * releasing evicts whatever lease is on the slot. Both are attributed: claims
 * to the given holder, releases logged against the operator's identity.
 */
const mutateSlotLease = createServerFn({ method: "POST" })
  .inputValidator(
    z.discriminatedUnion("action", [
      z.object({
        action: z.literal("claim"),
        type: z.string().trim().min(1),
        slug: z.string().trim().min(1),
        holder: z.string().trim().min(1).max(200),
      }),
      z.object({
        action: z.literal("release"),
        type: z.string().trim().min(1),
        slug: z.string().trim().min(1),
      }),
    ]),
  )
  .handler(async ({ context, data }) => {
    requireAdminPrincipal(context);
    const coordinator = env.RESOURCE_COORDINATOR.getByName(data.type);
    const currentLease = await coordinator.getLease({ type: data.type, slug: data.slug });

    if (data.action === "claim") {
      if (currentLease) {
        return {
          changed: false,
          message: `Already leased by ${currentLease.holder ?? "unknown"}.`,
        };
      }
      const lease = await coordinator.acquireSpecific({
        type: data.type,
        slug: data.slug,
        leaseMs: CLAIM_LEASE_MS,
        holder: data.holder,
      });
      if (!lease) {
        throw new Error("Slot is not available to claim.");
      }
      return {
        changed: true,
        message: `${data.slug} claimed for ${data.holder} until ${new Date(lease.expiresAt).toISOString()}.`,
      };
    }

    if (!currentLease) {
      return { changed: false, message: `${data.slug} is already available.` };
    }
    const released = await coordinator.release({
      type: data.type,
      slug: data.slug,
      leaseId: currentLease.leaseId,
    });
    if (!released) {
      throw new Error("Failed to release the lease.");
    }
    return {
      changed: true,
      message: `${data.slug} released (was held by ${currentLease.holder ?? "unknown"}).`,
    };
  });

export const Route = createFileRoute("/_app/resources/")({
  loader: () => loadResources(),
  component: ResourcesIndexPage,
  staticData: {
    breadcrumb: "All",
  },
});

function previewSlotNumber(slug: string): number | null {
  const match = /^preview-(\d+)$/.exec(slug);
  return match ? Number(match[1]) : null;
}

/** Holders written by the PR preview flow are `pr-<number>`; link them to the PR. */
function holderPullRequestUrl(holder: string | null | undefined): string | null {
  const match = /^pr-(\d+)$/.exec(holder ?? "");
  return match ? `https://github.com/iterate/iterate/pull/${match[1]}` : null;
}

function formatRelativeMs(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const span = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return deltaMs >= 0 ? `in ${span}` : `${span} ago`;
}

function ResourcesIndexPage() {
  const router = useRouter();
  const data = Route.useLoaderData();

  // A state dashboard should not need a manual reload to be believed.
  useEffect(() => {
    const interval = setInterval(() => void router.invalidate(), DASHBOARD_REFRESH_MS);
    return () => clearInterval(interval);
  }, [router]);

  // Most recent activity first: freshly claimed/released slots surface at the
  // top; never-touched slots sink to the bottom in slot order.
  const previewSlots = data
    .filter((resource) => resource.type === ENVIRONMENT_CONFIG_LEASE_TYPE)
    .sort(
      (left, right) =>
        (right.lastAcquiredAt ?? 0) - (left.lastAcquiredAt ?? 0) ||
        (previewSlotNumber(left.slug) ?? Number.MAX_SAFE_INTEGER) -
          (previewSlotNumber(right.slug) ?? Number.MAX_SAFE_INTEGER),
    );
  const otherResources = data.filter((resource) => resource.type !== ENVIRONMENT_CONFIG_LEASE_TYPE);
  const groupedResources = otherResources.reduce((groups, resource) => {
    const group = groups.get(resource.type) ?? [];
    group.push(resource);
    groups.set(resource.type, group);
    return groups;
  }, new Map<string, SerializableSemaphoreResource[]>());

  return (
    <section className="space-y-8">
      {previewSlots.length ? <PreviewEnvironmentsSection slots={previewSlots} /> : null}

      <div className="space-y-6">
        {Array.from(groupedResources.entries()).map(([type, resources]) => {
          const leasedCount = resources.filter(
            (resource) => resource.leaseState === "leased",
          ).length;

          return (
            <section key={type} className="space-y-3">
              <div className="space-y-1">
                <p className="font-medium">{type}</p>
                <p className="text-xs text-muted-foreground">
                  {leasedCount} leased · {resources.length - leasedCount} available
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {resources.map((resource) => (
                  <a
                    key={`${resource.type}:${resource.slug}`}
                    href={`/resources/${encodeURIComponent(resource.type)}/${encodeURIComponent(resource.slug)}/`}
                    className={`block rounded-lg border p-4 transition-colors hover:border-foreground/30 ${
                      resource.leaseState === "leased"
                        ? "border-amber-500/40 bg-amber-500/10"
                        : "border-emerald-500/30 bg-emerald-500/10"
                    }`}
                  >
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{resource.slug}</p>
                          <p className="truncate text-sm text-muted-foreground">{resource.type}</p>
                        </div>
                        <LeaseStateBadge leaseState={resource.leaseState} />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {resource.leasedUntil
                          ? `leased${resource.holder ? ` by ${resource.holder}` : ""} until ${new Date(resource.leasedUntil).toISOString()}`
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

      {!data.length ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          No resources are currently registered.
        </p>
      ) : null}
    </section>
  );
}

function PreviewEnvironmentsSection({ slots }: { slots: SerializableSemaphoreResource[] }) {
  const leasedCount = slots.filter((slot) => slot.leaseState === "leased").length;

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <p className="font-medium">Preview environments</p>
        <p className="text-xs text-muted-foreground">
          {leasedCount} leased · {slots.length - leasedCount} available · most recently acquired
          first · refreshes every {DASHBOARD_REFRESH_MS / 1000}s
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {slots.map((slot) => (
          <PreviewSlotCard key={slot.slug} slot={slot} />
        ))}
      </div>
    </section>
  );
}

/** A `key: value` row in a slot card's detail list. */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className="truncate text-right"
        title={typeof children === "string" ? children : undefined}
      >
        {children}
      </dd>
    </div>
  );
}

function formatInstant(epochMs: number) {
  return `${formatRelativeMs(epochMs - Date.now())} · ${new Date(epochMs).toISOString()}`;
}

function PreviewSlotCard({ slot }: { slot: SerializableSemaphoreResource }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const slotNumber = previewSlotNumber(slot.slug);
  const pullRequestUrl = holderPullRequestUrl(slot.holder);
  const leased = slot.leaseState === "leased";

  function runLeaseAction(input: Parameters<typeof mutateSlotLease>[0]["data"]) {
    startTransition(async () => {
      try {
        const result = await mutateSlotLease({ data: input });
        (result.changed ? toast.success : toast.info)(result.message);
        await router.invalidate();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    });
  }

  function onRelease() {
    if (!window.confirm(`Release ${slot.slug} (held by ${slot.holder ?? "unknown"})?`)) return;
    runLeaseAction({ action: "release", type: slot.type, slug: slot.slug });
  }

  function onClaim() {
    const answer = window.prompt(`Claim ${slot.slug} — for which PR? (number, e.g. 1656)`);
    if (!answer) return;
    const trimmed = answer.trim();
    const holder = /^#?\d+$/.test(trimmed) ? `pr-${trimmed.replace(/^#/, "")}` : trimmed;
    if (!holder) {
      toast.error("Enter a PR number (or any holder name).");
      return;
    }
    runLeaseAction({ action: "claim", type: slot.type, slug: slot.slug, holder });
  }

  return (
    <div
      className={`rounded-lg border p-4 ${
        leased ? "border-amber-500/40 bg-amber-500/10" : "border-emerald-500/30 bg-emerald-500/10"
      }`}
    >
      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-4">
          <a
            href={`/resources/${ENVIRONMENT_CONFIG_LEASE_TYPE}/${encodeURIComponent(slot.slug)}/`}
            className="min-w-0 font-medium hover:underline"
          >
            {slot.slug}
          </a>
          <LeaseStateBadge leaseState={slot.leaseState} />
        </div>

        <dl className="space-y-1 text-xs">
          {leased ? (
            <>
              <DetailRow label="held by">
                {pullRequestUrl ? (
                  <a
                    href={pullRequestUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium underline underline-offset-2"
                  >
                    {slot.holder}
                  </a>
                ) : (
                  <span className="font-medium">{slot.holder ?? "unknown holder"}</span>
                )}
              </DetailRow>
              {slot.leasedUntil ? (
                <DetailRow label="expires">{formatInstant(slot.leasedUntil)}</DetailRow>
              ) : null}
            </>
          ) : null}
          {slot.lastAcquiredAt ? (
            <DetailRow label="last acquired">{formatInstant(slot.lastAcquiredAt)}</DetailRow>
          ) : null}
          {slot.lastReleasedAt ? (
            <DetailRow label="last released">{formatInstant(slot.lastReleasedAt)}</DetailRow>
          ) : null}
          {typeof slot.data.dopplerConfig === "string" ? (
            <DetailRow label="doppler config">{slot.data.dopplerConfig}</DetailRow>
          ) : null}
        </dl>

        {Number.isFinite(slotNumber) ? (
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {(["os", "auth", "semaphore"] as const).map((app) => (
              <a
                key={app}
                href={`https://${app}.iterate-preview-${slotNumber}.com`}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                {app}
              </a>
            ))}
          </p>
        ) : null}

        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            raw state
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-background/60 p-2">
            {JSON.stringify(slot, null, 2)}
          </pre>
        </details>

        <div className="flex gap-2 pt-1">
          {leased ? (
            <button
              type="button"
              disabled={isPending}
              onClick={onRelease}
              className="rounded-md border border-foreground/20 bg-background/40 px-3 py-1.5 text-xs font-medium hover:bg-background/70 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? "Working…" : "Release"}
            </button>
          ) : (
            <button
              type="button"
              disabled={isPending}
              onClick={onClaim}
              className="rounded-md border border-foreground/20 bg-background/40 px-3 py-1.5 text-xs font-medium hover:bg-background/70 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? "Working…" : "Claim for PR…"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function LeaseStateBadge({ leaseState }: { leaseState: string }) {
  const leased = leaseState === "leased";
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${
        leased ? "border-amber-500/40 text-amber-600" : "border-emerald-500/40 text-emerald-600"
      }`}
    >
      {leaseState}
    </span>
  );
}
