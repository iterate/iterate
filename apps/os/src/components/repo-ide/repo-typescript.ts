import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Remote } from "comlink";
import type { WorkerShape } from "@valtown/codemirror-ts/worker";
import type { SourceCodeBlockExtension } from "@iterate-com/ui/components/source-code-block";
import { itxReplAutocompleteWorker } from "../itx-repl-autocomplete.ts";
import {
  desiredRepoVfs,
  isTypeScriptEditorPath,
  repoSeedPaths,
  repoVfsDiff,
  vfsPath,
} from "./repo-typescript-vfs.ts";
import type { RepoTypeScriptWorkerApi } from "./repo-typescript.worker.ts";
import { workingTreeStore } from "./staged-changes.ts";
import { useItx, type ItxReactHandle } from "~/itx/itx-react.tsx";

/**
 * Host side of the repo IDE's TypeScript language service (the worker lives
 * in `./repo-typescript.worker.ts`): one session per repo owning the worker,
 * its seed, and the working-tree sync.
 *
 * Sync is reconciliation, not event-chasing — the session subscribes to the
 * repo's working-tree store and, on every change, computes the desired vfs
 * contents (effective working/staged entry per path, else cached HEAD
 * content) and diffs against what it last pushed (the pure functions in
 * `./repo-typescript-vfs.ts`). Creates, edits, discards, deletes, and
 * renames all fall out of the same diff, and it doubles as the per-keystroke
 * buffer sync (the editor writes every change into the store), so the stock
 * `tsSyncWorker` extension is deliberately not used — one sync path instead
 * of two racing ones.
 */

class RepoTypeScriptSession {
  #worker: Worker;
  #remote: Remote<RepoTypeScriptWorkerApi>;
  #releaseRemote: () => void;
  /** What the editor extensions talk to — see {@link workerFacade}. */
  worker: ReturnType<typeof workerFacade>;
  /** HEAD contents of TypeScript-relevant paths (repo-relative keys). */
  #headContents = new Map<string, string>();
  /** What the vfs currently holds (repo-relative keys) — the diff baseline. */
  #pushed = new Map<string, string>();
  #store: ReturnType<typeof workingTreeStore> | null = null;
  #unsubscribe: (() => void) | null = null;
  #initialized = false;
  #terminated = false;
  #syncedCommitOid: string | null = null;
  /** Serializes seed/resync so a commit landing mid-seed can't interleave. */
  #chain: Promise<unknown> = Promise.resolve();
  /** typm (type acquisition) plumbing — see #maybeAcquireTypes. */
  #typesAcquiredListeners = new Set<() => void>();
  #acquireTimer: ReturnType<typeof setTimeout> | null = null;
  #lastRequestedPackageJson: string | null = null;

  constructor(
    private input: { projectId: string; repoPath: string },
    comlink: typeof import("comlink"),
  ) {
    this.#worker = new Worker(new URL("./repo-typescript.worker.ts", import.meta.url), {
      type: "module",
    });
    const remote = comlink.wrap<RepoTypeScriptWorkerApi>(this.#worker);
    this.#remote = remote;
    this.worker = workerFacade(remote);
    this.#releaseRemote = () => remote[comlink.releaseProxy]();
  }

  /** Seed on first call; on later calls re-sync HEAD contents when a commit
   * moved the oid (the worker and its warm language service survive). */
  ensureSynced(itx: ItxReactHandle, commitOid: string): Promise<void> {
    const run = this.#chain.then(async () => {
      if (this.#terminated || this.#syncedCommitOid === commitOid) return;
      const repo = itx.repos.get(this.input.repoPath);
      const { paths } = await repo.listFiles();
      const seedPaths = repoSeedPaths(paths);
      const reads = await Promise.all(
        seedPaths.map(async (path) => [path, (await repo.readFile({ path }))?.content] as const),
      );
      // Terminated while awaiting the seed fan-out (the user navigated to
      // another repo): stop before touching the store. A subscription
      // registered now would outlive the session — and its reconcile would
      // throw released-proxy errors inside the store's listener loop,
      // starving every listener registered after it.
      if (this.#terminated) return;
      this.#headContents = new Map(
        reads.flatMap(([path, content]) => (typeof content === "string" ? [[path, content]] : [])),
      );
      this.#store = workingTreeStore({ ...this.input, commitOid });
      this.#unsubscribe?.();
      this.#unsubscribe = null;
      if (!this.#initialized) {
        const desired = desiredRepoVfs(this.#headContents, this.#store.changes);
        await this.#remote.initializeRepo({
          files: Object.fromEntries(
            [...desired].map(([path, content]) => [vfsPath(path), content]),
          ),
          tsconfigText: desired.get("tsconfig.json") ?? null,
        });
        this.#pushed = desired;
        this.#initialized = true;
        if (this.#terminated) return;
        // First seed: kick typm immediately (no debounce). The reconcile
        // below no-ops for acquisition — same package.json text.
        this.#maybeAcquireTypes(desired, 0);
      }
      // Subscribe only now that the environment exists, then reconcile once:
      // edits made during the awaits above are caught by the diff here. A
      // subscription live during the seed would have "pushed" them into a
      // worker whose updateFile still no-ops (no env yet) while recording
      // them as delivered — silently freezing that buffer's vfs content at
      // its seed-time value.
      this.#unsubscribe = this.#store.subscribe(() => this.#reconcile());
      this.#reconcile();
      this.#syncedCommitOid = commitOid;
    });
    this.#chain = run.catch(() => {});
    return run;
  }

  #reconcile(): void {
    if (this.#terminated || this.#store === null) return;
    const desired = desiredRepoVfs(this.#headContents, this.#store.changes);
    const { updates, removals } = repoVfsDiff(this.#pushed, desired);
    this.#pushed = desired;
    if (Object.keys(updates).length > 0) void this.#remote.setFiles(updates);
    if (removals.length > 0) void this.#remote.deleteFiles(removals);
    this.#maybeAcquireTypes(desired, 1000);
  }

  /** Fires when a typm run landed new `.d.ts` files in the worker (the
   * editor's lints are push-cached, so listeners force a re-lint). Returns an
   * unsubscribe. A class-field closure (not a method) on purpose: its
   * identity is stable for the life of the session, so the extension memo in
   * {@link useRepoTypeScriptExtensions} survives post-commit refetches — and
   * it's a plain function, safe for React to see (see {@link workerFacade}). */
  onTypesAcquired = (listener: () => void): (() => void) => {
    this.#typesAcquiredListeners.add(listener);
    return () => this.#typesAcquiredListeners.delete(listener);
  };

  /**
   * Kick typm (npm type acquisition) in the worker whenever the effective
   * package.json content changes. Debounced — package.json edits arrive per
   * keystroke — and cheap to over-call: the worker no-ops unless the parsed
   * dependency maps actually changed. Failures degrade to the prelude's
   * `declare module "*"` wildcard (bare imports stay `any`), never the editor.
   */
  #maybeAcquireTypes(desired: Map<string, string>, delayMs: number): void {
    const packageJsonText = desired.get("package.json");
    if (packageJsonText === undefined) {
      // package.json removed: cancel any pending debounced acquisition so a
      // timer armed by an earlier edit can't fire and re-acquire types for a
      // manifest that no longer exists, and reset the guard so re-adding a
      // package.json acquires again.
      if (this.#acquireTimer) clearTimeout(this.#acquireTimer);
      this.#acquireTimer = null;
      this.#lastRequestedPackageJson = null;
      return;
    }
    if (packageJsonText === this.#lastRequestedPackageJson) return;
    this.#lastRequestedPackageJson = packageJsonText;
    if (this.#acquireTimer) clearTimeout(this.#acquireTimer);
    this.#acquireTimer = setTimeout(() => {
      if (this.#terminated) return;
      // A failed run (offline at seed, CDN down) must forget the requested
      // text — otherwise this guard blocks every retrigger until the
      // package.json literally changes and the session stays wildcard-`any`
      // for its whole life. Forgetting lets the next reconcile (any edit)
      // retry; the worker dedupes retries by dependency snapshot, so they
      // cost nothing once one succeeds. Guarded against a newer request
      // having been made while this one ran.
      const forgetOnFailure = () => {
        if (this.#lastRequestedPackageJson === packageJsonText) {
          this.#lastRequestedPackageJson = null;
        }
      };
      void this.#remote
        .acquireTypes({ packageJsonText })
        .then((result) => {
          if (result.failed) return forgetOnFailure();
          if (!result.acquired) return;
          for (const listener of this.#typesAcquiredListeners) listener();
        })
        .catch((error) => {
          forgetOnFailure();
          console.error("[repo-ide] typm type acquisition failed", error);
        });
    }, delayMs);
  }

  terminate(): void {
    this.#terminated = true;
    if (this.#acquireTimer) clearTimeout(this.#acquireTimer);
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#releaseRemote();
    this.#worker.terminate();
  }
}

/**
 * Plain delegating closures over the comlink remote, one per method the
 * editor extensions call. NEVER hand the extensions (or anything else
 * React-visible — the facet value travels through component props) the
 * comlink proxy itself: React 19's dev-mode component performance logging
 * stringifies changed props, and String() on a comlink proxy throws
 * ("Cannot convert object to primitive value"), aborting the whole React
 * commit and unmounting the editor. Closures keep the proxy reachable only
 * lexically, invisible to any serializer.
 */
function workerFacade(remote: Remote<RepoTypeScriptWorkerApi>) {
  return {
    initialize: () => remote.initialize(),
    updateFile: (input: { path: string; code: string }) => remote.updateFile(input),
    getLints: (input: { path: string; diagnosticCodesToIgnore: number[] }) =>
      remote.getLints({
        ...input,
        // TS2347 ("Untyped function calls may not accept type arguments") is
        // guaranteed noise while bare npm imports are `any` (see the worker
        // prelude) — e.g. the template sdk's `kv.get<number>(…)`. Suppressed
        // HERE, in the editor's lint lane only, so the language service
        // itself stays honest for future consumers (a Problems panel should
        // decide for itself). Real acquired types (typm) end the noise;
        // drop this then.
        diagnosticCodesToIgnore: [...input.diagnosticCodesToIgnore, 2347],
      }),
    getAutocompletion: (input: Parameters<RepoTypeScriptWorkerApi["getAutocompletion"]>[0]) =>
      remote.getAutocompletion(input),
    getAutocompletionWithDocs: (
      input: Parameters<RepoTypeScriptWorkerApi["getAutocompletionWithDocs"]>[0],
    ) => remote.getAutocompletionWithDocs(input),
    getHover: (input: { path: string; pos: number }) => remote.getHover(input),
  };
}

/**
 * At most ONE live session — acquiring a different repo's session terminates
 * the previous worker, so navigating between repos never accumulates workers.
 * (Same module-level pattern as `workingTreeStore`.) There is deliberately
 * no teardown on route unmount: the warm language service survives in-app
 * navigation away and back, and this one-slot registry is what bounds the
 * cost at a single worker.
 */
const sessions = new Map<string, RepoTypeScriptSession>();

function repoTypeScriptSession(
  input: { projectId: string; repoPath: string },
  comlink: typeof import("comlink"),
): RepoTypeScriptSession {
  const key = `${input.projectId}:${input.repoPath}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  for (const [staleKey, stale] of sessions) {
    stale.terminate();
    sessions.delete(staleKey);
  }
  const created = new RepoTypeScriptSession(input, comlink);
  sessions.set(key, created);
  return created;
}

const loadExtensionModules = import.meta.env.SSR
  ? null
  : async () =>
      Promise.all([
        import("comlink"),
        import("@valtown/codemirror-ts"),
        import("@codemirror/autocomplete"),
        import("@codemirror/view"),
        import("@codemirror/lint"),
        import("@codemirror/state"),
      ]);

/**
 * The TypeScript language-service extensions for one open repo buffer:
 * diagnostics (lint squigglies), hover type info, and autocomplete with doc
 * strings. Empty while the worker seeds (or for non-TS files) — the editor
 * mounts immediately and the extensions attach when ready.
 */
export function useRepoTypeScriptExtensions(input: {
  projectId: string;
  repoPath: string;
  commitOid: string;
  path: string;
  enabled: boolean;
}): readonly SourceCodeBlockExtension[] {
  const itx = useItx();
  const enabled =
    input.enabled && isTypeScriptEditorPath(input.path) && Boolean(loadExtensionModules);
  const query = useQuery({
    // The session registry dedupes the worker per repo; keying by commitOid
    // makes a commit re-run ensureSynced (HEAD resync) through the query.
    queryKey: ["repo-typescript", input.projectId, input.repoPath, input.commitOid],
    queryFn: async () => {
      try {
        const [comlink, codemirrorTs, autocomplete, view, lint, state] =
          await loadExtensionModules!();
        const session = repoTypeScriptSession(
          { projectId: input.projectId, repoPath: input.repoPath },
          comlink,
        );
        await session.ensureSynced(itx, input.commitOid);
        // Only the plain facade goes into query data (which React sees) —
        // never the session/remote; see workerFacade. onTypesAcquired is a
        // plain class-field closure, stable per session, for the same reason.
        return {
          worker: session.worker,
          onTypesAcquired: session.onTypesAcquired,
          codemirrorTs,
          autocomplete,
          view,
          lint,
          state,
        };
      } catch (error) {
        // The editor works fine without the language service, so failures
        // here are invisible by design — except in the console.
        console.error("[repo-ide] TypeScript language service failed to start", error);
        throw error;
      }
    },
    enabled,
    staleTime: Infinity,
    // Drop the cache the moment no editor observes it: navigating to another
    // repo TERMINATES this repo's worker (see repoTypeScriptSession), so a
    // cached result would hand a later visit a dead session. Refetches while
    // the session is alive are near-free — ensureSynced short-circuits on a
    // matching commit oid before any network round trip.
    gcTime: 0,
    // A commit flips the queryKey (new oid); keep serving the previous
    // result while ensureSynced resyncs instead of flashing squigglies off
    // through an `undefined` gap. Safe because the facade and module
    // namespaces are reference-stable for the life of the session, and repo
    // switches remount the hook (RepoIde is keyed per repo) so stale data
    // can't bridge across workers.
    placeholderData: keepPreviousData,
    retry: 1,
  });

  // Memoize on the stable PARTS, not the query-data envelope: the facade and
  // module namespaces keep their identity across refetches, so the extension
  // array (and therefore the EditorView, which SourceCodeBlock rebuilds on
  // extension identity change) survives the post-commit refetch untouched.
  const worker = query.data?.worker;
  const onTypesAcquired = query.data?.onTypesAcquired;
  const codemirrorTs = query.data?.codemirrorTs;
  const autocomplete = query.data?.autocomplete;
  const view = query.data?.view;
  const lint = query.data?.lint;
  const state = query.data?.state;
  const path = input.path;
  return useMemo(() => {
    if (
      !worker ||
      !onTypesAcquired ||
      !codemirrorTs ||
      !autocomplete ||
      !view ||
      !lint ||
      !state ||
      !enabled
    ) {
      return [];
    }
    const { tsFacetWorker, tsLinterWorker, tsHoverWorker } = codemirrorTs;
    // Lints are push-cached per buffer, and forceLinting alone only flushes a
    // PENDING lint query — untouched since its last pass, a buffer has none,
    // so freshly-acquired types would never repaint its squigglies (verified
    // live: the type error only appeared after a keystroke). The effect +
    // needsRefresh pair marks the lint state stale first; forceLinting then
    // has something to flush and the repaint is immediate.
    const typesAcquired = state.StateEffect.define<null>();
    return [
      // No tsSyncWorker on purpose — see the module docstring: the working
      // tree store is the single buffer-sync path into the worker.
      tsFacetWorker.of({
        path: vfsPath(path),
        worker: worker as unknown as WorkerShape,
      }),
      tsLinterWorker(),
      autocomplete.autocompletion({
        activateOnTyping: true,
        activateOnTypingDelay: 0,
        override: [itxReplAutocompleteWorker(tsFacetWorker)],
      }),
      tsHoverWorker(),
      lint.linter(null, {
        needsRefresh: (update) =>
          update.transactions.some((tr) => tr.effects.some((effect) => effect.is(typesAcquired))),
      }),
      view.ViewPlugin.define((editorView) => {
        const unsubscribe = onTypesAcquired(() => {
          editorView.dispatch({ effects: typesAcquired.of(null) });
          lint.forceLinting(editorView);
        });
        return { destroy: unsubscribe };
      }),
      // The hover tooltip escapes the editor into the file pane's stacking
      // context; keep it above the sticky header/toolbar chrome.
      view.EditorView.theme({ ".cm-tooltip": { zIndex: "30" } }),
    ];
  }, [worker, onTypesAcquired, codemirrorTs, autocomplete, view, lint, state, enabled, path]);
}
