/**
 * Durable Object migration state for deployed workers — reading it, resetting
 * it, and converging on it.
 *
 * Cloudflare tracks a worker's DO classes and its migration tag ON the
 * deployed script; `wrangler deploy` diffs the config's static migration list
 * against that tag. On a single-owner env (prd only ever deploys from main)
 * the list is append-only and the diff is always right. Preview slots break
 * the assumption: the same worker script is deployed by many branches whose
 * migration histories diverge — a handover from another PR, or a branch
 * renumbering its own tags after a main merge. Wrangler then either replays
 * creates onto classes that already exist (API error 10074/10061) or
 * silently skips a class it should create. Observed live 2026-07-08 on
 * preview-2 / PR #1747: the branch shipped its sandbox classes as tag v3,
 * main took v3 for WorkspaceDurableObject, the merge renumbered the sandbox
 * migration to v4, and the next deploy replayed "create SandboxLite*" onto
 * live instances → 10074, slot dead until manual surgery.
 *
 * Two moves close the failure class:
 *
 *  - {@link resetWorkerDurableObjects} — destroy-all: upload a placeholder
 *    script whose migration `deleted_classes`es every live class. This is
 *    the only control-plane way to delete DO instances (storage, alarms and
 *    all) and it resets the migration history, so ANY branch's next deploy
 *    replays its own list onto a clean slate. erase-data runs this, which
 *    makes every preview-slot handover a true teardown.
 *
 *  - {@link convergeDoMigrations} — deploy-time convergence: ignore tags,
 *    diff the config's desired class set against the classes that actually
 *    exist on the worker, and emit exactly the steps that close the gap.
 *    Preview deploys use this so a slot deploys cleanly from whatever DO
 *    state the previous deploy (any branch, any tag history) left behind.
 */
import { createHash } from "node:crypto";
import type { DeployableEnv, EnvContext } from "./env-context.ts";

/** The slice of EnvContext these helpers need: the account-scoped CF API fetch. */
type CfContext = Pick<EnvContext<DeployableEnv>, "cf">;

/** One entry of a wrangler config's `migrations` list. */
export type DoMigrationStep = {
  tag: string;
  new_classes?: string[];
  new_sqlite_classes?: string[];
  renamed_classes?: { from: string; to: string }[];
  deleted_classes?: string[];
};

/**
 * A worker's live Durable Object state as the Cloudflare control plane sees
 * it: whether the script exists at all, the migration tag its last applied
 * migration set, and the DO namespaces (class + namespace id) bound to it.
 */
export type WorkerDoState = {
  scriptExists: boolean;
  migrationTag: string | null;
  namespaces: { className: string; namespaceId: string }[];
};

/** Read {@link WorkerDoState} for one worker script. */
export async function getWorkerDoState(ctx: CfContext, workerName: string): Promise<WorkerDoState> {
  // Same source wrangler uses for the tag: the scripts listing (the
  // per-script settings endpoint does not expose migration_tag).
  const scripts = await ctx.cf<{ id: string; migration_tag?: string | null }[]>(`/workers/scripts`);
  const script = scripts.find((candidate) => candidate.id === workerName);
  if (!script) return { scriptExists: false, migrationTag: null, namespaces: [] };

  const namespaces: { className: string; namespaceId: string }[] = [];
  for (let page = 1; ; page++) {
    const batch = await ctx.cf<{ id: string; script: string | null; class: string }[]>(
      `/workers/durable_objects/namespaces?per_page=100&page=${page}`,
    );
    for (const namespace of batch) {
      if (namespace.script === workerName) {
        namespaces.push({ className: namespace.class, namespaceId: namespace.id });
      }
    }
    if (batch.length < 100) break;
  }
  return { scriptExists: true, migrationTag: script.migration_tag ?? null, namespaces };
}

/** The class set a migration list nets out to after replaying every step. */
export function desiredClassesFromMigrations(migrations: DoMigrationStep[]): Set<string> {
  const classes = new Set<string>();
  for (const step of migrations) {
    for (const className of [...(step.new_classes ?? []), ...(step.new_sqlite_classes ?? [])]) {
      classes.add(className);
    }
    for (const rename of step.renamed_classes ?? []) {
      classes.delete(rename.from);
      classes.add(rename.to);
    }
    for (const className of step.deleted_classes ?? []) {
      classes.delete(className);
    }
  }
  return classes;
}

/** Deterministic 8-hex-char tag suffix so the same diff always names the same tag. */
function tagHash(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 8);
}

/**
 * Replace a config's static migration list with one computed against the
 * worker's live DO state, so the deploy converges from ANY starting point.
 *
 * Returns null when the static list is already correct — a worker that has
 * never carried DOs (fresh env, or reset placeholder with no tag) replays
 * the full list onto a clean slate, which is exactly what the static list
 * describes.
 *
 * Otherwise returns a two-entry list wrangler turns into exactly the right
 * upload: the first entry is the live tag (wrangler finds it and sends only
 * the steps after it), the second is one step creating every missing class
 * and deleting every stale one. Classes are always created as SQLite-backed —
 * every class in this repo is.
 */
export function convergeDoMigrations(input: {
  configMigrations: DoMigrationStep[];
  liveTag: string | null;
  liveClasses: string[];
}): { migrations: DoMigrationStep[]; summary: string } | null {
  if (input.configMigrations.length === 0) return null;
  if (!input.liveTag && input.liveClasses.length === 0) return null;

  const desired = desiredClassesFromMigrations(input.configMigrations);
  const live = new Set(input.liveClasses);
  const missing = [...desired].filter((className) => !live.has(className)).sort();
  const stale = [...live].filter((className) => !desired.has(className)).sort();

  if (missing.length === 0 && stale.length === 0) {
    if (!input.liveTag) {
      // Classes match but the script never got a tag: replaying the static
      // list would re-create existing classes. Adopt a tag with a no-op step.
      return {
        migrations: [{ tag: `sync-${tagHash([null, [], []])}` }],
        summary: "live classes already match; adopting a migration tag",
      };
    }
    return {
      migrations: [{ tag: input.liveTag }],
      summary: `live classes already match tag ${input.liveTag}; no steps to apply`,
    };
  }

  const syncStep: DoMigrationStep = {
    tag: `sync-${tagHash([input.liveTag, missing, stale])}`,
    ...(missing.length > 0 ? { new_sqlite_classes: missing } : {}),
    ...(stale.length > 0 ? { deleted_classes: stale } : {}),
  };
  return {
    migrations: [...(input.liveTag ? [{ tag: input.liveTag }] : []), syncStep],
    summary:
      `from ${input.liveTag ?? "untagged"}: ` +
      `create [${missing.join(", ") || "none"}], delete [${stale.join(", ") || "none"}]`,
  };
}

/**
 * What a worker answers while its DOs are being reset: parked until the next
 * deploy. Deliberately a 503 — preview machinery treats "parked" as healthy.
 */
const RESET_PLACEHOLDER_MODULE = `export default {
  fetch: () => new Response("This environment's Durable Objects were erased; the next deploy brings it back.", {
    status: 503,
    headers: { "content-type": "text/plain" },
  }),
};
`;

/**
 * Destroy every Durable Object on a worker — instances, storage, alarms —
 * and reset its migration history, by uploading a placeholder script whose
 * migration deletes all live classes (the only control-plane way to delete
 * DO instances). Container applications attached to the deleted classes'
 * namespaces are deleted first (their instances die with them). The worker
 * script itself and its routes stay — deleting the script cascades its
 * routes, the historical zombie-route/522 class — so the worker serves the
 * placeholder's 503 until the next deploy.
 */
export async function resetWorkerDurableObjects(
  ctx: CfContext,
  workerName: string,
): Promise<
  | { action: "skipped"; reason: string }
  | { action: "reset"; deletedClasses: string[]; newTag: string }
> {
  const state = await getWorkerDoState(ctx, workerName);
  if (!state.scriptExists) {
    console.log(`DO reset: worker ${workerName} does not exist — nothing to destroy`);
    return { action: "skipped", reason: "script does not exist" };
  }
  if (state.namespaces.length === 0) {
    console.log(`DO reset: worker ${workerName} has no Durable Object classes — already clean`);
    return { action: "skipped", reason: "no Durable Object classes" };
  }

  // Container applications pin their DO namespace; drop them (and their
  // running instances) before the migration deletes the classes. Best-effort:
  // if the containers API misbehaves, let the script upload surface the
  // real failure.
  const namespaceIds = new Set(state.namespaces.map((namespace) => namespace.namespaceId));
  try {
    const applications =
      await ctx.cf<{ id: string; name: string; durable_objects?: { namespace_id?: string } }[]>(
        `/containers/applications`,
      );
    for (const application of applications) {
      const namespaceId = application.durable_objects?.namespace_id;
      if (namespaceId && namespaceIds.has(namespaceId)) {
        await ctx.cf(`/containers/applications/${application.id}`, { method: "DELETE" });
        console.log(`DO reset: deleted container application ${application.name}`);
      }
    }
  } catch (error) {
    console.warn(`DO reset: container application cleanup skipped (${error})`);
  }

  const deletedClasses = state.namespaces.map((namespace) => namespace.className).sort();
  const newTag = `do-reset-${tagHash([state.migrationTag, deletedClasses])}`;
  const metadata = {
    main_module: "reset.mjs",
    compatibility_date: "2026-01-01",
    bindings: [],
    migrations: {
      ...(state.migrationTag ? { old_tag: state.migrationTag } : {}),
      new_tag: newTag,
      steps: [{ deleted_classes: deletedClasses }],
    },
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append(
    "reset.mjs",
    new File([RESET_PLACEHOLDER_MODULE], "reset.mjs", { type: "application/javascript+module" }),
    "reset.mjs",
  );
  await ctx.cf(`/workers/scripts/${workerName}`, { method: "PUT", body: form });
  console.log(
    `DO reset: ${workerName} destroyed ${deletedClasses.length} classes ` +
      `(${deletedClasses.join(", ")}); migration history reset ` +
      `(${state.migrationTag ?? "untagged"} → ${newTag}); parked at 503 until the next deploy`,
  );
  return { action: "reset", deletedClasses, newTag };
}
