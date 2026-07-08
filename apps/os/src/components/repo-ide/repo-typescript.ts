import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Remote } from "comlink";
import type { WorkerShape } from "@valtown/codemirror-ts/worker";
import type { SourceCodeBlockExtension } from "@iterate-com/ui/components/source-code-block";
import { itxReplAutocompleteWorker } from "../itx-repl-autocomplete.ts";
import type { RepoTypeScriptWorkerApi } from "./repo-typescript.worker.ts";
import { effectiveEntry, workingTreeStore } from "./staged-changes.ts";
import { useItx, type ItxReactHandle } from "~/itx/itx-react.tsx";

/**
 * Host side of the repo IDE's TypeScript language service (the worker lives
 * in `./repo-typescript.worker.ts`): one session per repo owning the worker,
 * its seed, and the working-tree sync.
 *
 * Sync is reconciliation, not event-chasing — the session subscribes to the
 * repo's working-tree store and, on every change, computes the desired vfs
 * contents (effective working/staged entry per path, else cached HEAD
 * content) and diffs against what it last pushed. Creates, edits, discards,
 * deletes, and renames all fall out of the same diff, and it doubles as the
 * per-keystroke buffer sync (the editor writes every change into the store),
 * so the stock `tsSyncWorker` extension is deliberately not used — one sync
 * path instead of two racing ones.
 */

const TYPESCRIPT_SEED_EXTENSIONS = new Set([
  "cjs",
  "cts",
  "js",
  "json",
  "jsx",
  "mjs",
  "mts",
  "ts",
  "tsx",
]);

/** Files worth showing to the TypeScript program: sources it can check plus
 * `.json` for `resolveJsonModule` (which also carries tsconfig.json in). */
export function isTypeScriptSeedPath(path: string): boolean {
  const extension = path.split(".").pop() || "";
  return TYPESCRIPT_SEED_EXTENSIONS.has(extension.toLowerCase());
}

/** Whether the language service attaches to this open buffer at all. */
export function isTypeScriptEditorPath(path: string): boolean {
  const extension = (path.split(".").pop() || "").toLowerCase();
  return isTypeScriptSeedPath(path) && extension !== "json";
}

/** Repo paths are relative ("src/x.ts"); the vfs wants rooted ("/src/x.ts"). */
function vfsPath(repoPath: string): string {
  return `/${repoPath}`;
}

const MAX_SEED_FILES = 500;

class RepoTypeScriptSession {
  #worker: Worker;
  remote: Remote<RepoTypeScriptWorkerApi>;
  #releaseRemote: () => void;
  /** HEAD contents of TypeScript-relevant paths (repo-relative keys). */
  #headContents = new Map<string, string>();
  /** What the vfs currently holds (repo-relative keys) — the diff baseline. */
  #pushed = new Map<string, string>();
  #store: ReturnType<typeof workingTreeStore> | null = null;
  #unsubscribe: (() => void) | null = null;
  #initialized = false;
  #syncedCommitOid: string | null = null;
  /** Serializes seed/resync so a commit landing mid-seed can't interleave. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(
    private input: { projectId: string; repoPath: string },
    comlink: typeof import("comlink"),
  ) {
    this.#worker = new Worker(new URL("./repo-typescript.worker.ts", import.meta.url), {
      type: "module",
    });
    const remote = comlink.wrap<RepoTypeScriptWorkerApi>(this.#worker);
    this.remote = remote;
    this.#releaseRemote = () => remote[comlink.releaseProxy]();
  }

  /** Seed on first call; on later calls re-sync HEAD contents when a commit
   * moved the oid (the worker and its warm language service survive). */
  ensureSynced(itx: ItxReactHandle, commitOid: string): Promise<void> {
    const run = this.#chain.then(async () => {
      if (this.#syncedCommitOid === commitOid) return;
      const repo = itx.repos.get(this.input.repoPath);
      const { paths } = await repo.listFiles();
      const seedPaths = paths.filter(isTypeScriptSeedPath).sort();
      if (seedPaths.length > MAX_SEED_FILES) {
        console.warn(
          `[repo-ide] TypeScript language service is only seeing the first ${MAX_SEED_FILES} of ${seedPaths.length} TypeScript-relevant files.`,
        );
        seedPaths.length = MAX_SEED_FILES;
      }
      const reads = await Promise.all(
        seedPaths.map(async (path) => [path, (await repo.readFile({ path }))?.content] as const),
      );
      this.#headContents = new Map(
        reads.flatMap(([path, content]) => (typeof content === "string" ? [[path, content]] : [])),
      );
      this.#store = workingTreeStore({ ...this.input, commitOid });
      this.#unsubscribe?.();
      this.#unsubscribe = this.#store.subscribe(() => this.#reconcile());
      if (!this.#initialized) {
        const desired = this.#desired();
        await this.remote.initializeRepo({
          files: Object.fromEntries(
            [...desired].map(([path, content]) => [vfsPath(path), content]),
          ),
          tsconfigText: desired.get("tsconfig.json") ?? null,
        });
        this.#pushed = desired;
        this.#initialized = true;
      } else {
        this.#reconcile();
      }
      this.#syncedCommitOid = commitOid;
    });
    this.#chain = run.catch(() => {});
    return run;
  }

  /** HEAD overlaid with the working tree: what the vfs SHOULD contain. */
  #desired(): Map<string, string> {
    const desired = new Map(this.#headContents);
    for (const [path, change] of this.#store?.changes ?? []) {
      if (!isTypeScriptSeedPath(path)) continue;
      const entry = effectiveEntry(change);
      if (entry === undefined) continue;
      if (entry.type === "write") desired.set(path, entry.content);
      else if (entry.type === "delete") desired.delete(path);
      // write-base64 entries are binary uploads — nothing for the program.
    }
    return desired;
  }

  #reconcile(): void {
    const desired = this.#desired();
    const updates: Record<string, string> = {};
    for (const [path, content] of desired) {
      if (this.#pushed.get(path) !== content) updates[vfsPath(path)] = content;
    }
    const removals = [...this.#pushed.keys()]
      .filter((path) => !desired.has(path))
      .map((path) => vfsPath(path));
    this.#pushed = desired;
    if (Object.keys(updates).length > 0) void this.remote.setFiles(updates);
    if (removals.length > 0) void this.remote.deleteFiles(removals);
  }

  terminate(): void {
    this.#unsubscribe?.();
    this.#releaseRemote();
    this.#worker.terminate();
  }
}

/**
 * At most ONE live session — acquiring a different repo's session terminates
 * the previous worker, so navigating between repos never accumulates workers.
 * (Same module-level pattern as `workingTreeStore`.)
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
      const [comlink, codemirrorTs, autocomplete, view] = await loadExtensionModules!();
      const session = repoTypeScriptSession(
        { projectId: input.projectId, repoPath: input.repoPath },
        comlink,
      );
      await session.ensureSynced(itx, input.commitOid);
      return { session, codemirrorTs, autocomplete, view };
    },
    enabled,
    staleTime: Infinity,
    // Drop the cache the moment no editor observes it: navigating to another
    // repo TERMINATES this repo's worker (see repoTypeScriptSession), so a
    // cached result would hand a later visit a dead session. Refetches while
    // the session is alive are near-free — ensureSynced short-circuits on a
    // matching commit oid before any network round trip.
    gcTime: 0,
    retry: 1,
  });

  const data = query.data;
  const path = input.path;
  return useMemo(() => {
    if (!data || !enabled) return [];
    const { tsFacetWorker, tsLinterWorker, tsHoverWorker } = data.codemirrorTs;
    return [
      // No tsSyncWorker on purpose — see the module docstring: the working
      // tree store is the single buffer-sync path into the worker.
      tsFacetWorker.of({
        path: vfsPath(path),
        worker: data.session.remote as unknown as WorkerShape,
      }),
      tsLinterWorker(),
      data.autocomplete.autocompletion({
        activateOnTyping: true,
        activateOnTypingDelay: 0,
        override: [itxReplAutocompleteWorker(tsFacetWorker)],
      }),
      tsHoverWorker(),
      // The hover tooltip escapes the editor into the file pane's stacking
      // context; keep it above the sticky header/toolbar chrome.
      data.view.EditorView.theme({ ".cm-tooltip": { zIndex: "30" } }),
    ];
  }, [data, enabled, path]);
}
