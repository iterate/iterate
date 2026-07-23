/**
 * The collaborative checkout's shared vocabulary — used by the Durable Object
 * (checkout-do.ts) and the browser client (use-checkout.ts). A checkout is an
 * in-DO working copy of the repo's task files: one Y.Doc holding a "files"
 * map of path → Y.Text plus a "meta" map with the base commit it was seeded
 * from. Everyone edits the same doc (the WebSocket wire is stock
 * y-protocols, served by y-partyserver); commits flush the doc's diff
 * against base back to git via plain HTTP POSTs.
 */
import * as Y from "yjs";
import type { RepoFileChange, TaskChangeSummary } from "../state.ts";
import { isTaskFilePath, parseTaskCard } from "../tasks-model.ts";

export function checkoutFilesMap(doc: Y.Doc): Y.Map<Y.Text> {
  return doc.getMap<Y.Text>("files");
}

/**
 * Durable attribution: every Yjs item already carries its author's
 * clientID; this map gives those ids a face. Clients register themselves on
 * join (verified identity when available), the checkout DO registers as
 * "agent" — so recency glows and hover attribution keep working even after
 * the author disconnects.
 */
export type CollaboratorInfo = {
  name: string;
  color: string;
  userId?: string;
  email?: string;
  agent?: boolean;
};

/** All API-lane writes share the DO's doc client, so agents wear one identity. */
export const AGENT_COLLABORATOR: CollaboratorInfo = { agent: true, color: "#8b5cf6", name: "agent" };

function checkoutCollaboratorsMap(doc: Y.Doc): Y.Map<CollaboratorInfo> {
  return doc.getMap<CollaboratorInfo>("collaborators");
}

export function registerCollaborator(doc: Y.Doc, info: CollaboratorInfo): void {
  const map = checkoutCollaboratorsMap(doc);
  const key = String(doc.clientID);
  const current = map.get(key);
  if (current === undefined || JSON.stringify(current) !== JSON.stringify(info)) {
    map.set(key, info);
  }
}

export function collaboratorFor(doc: Y.Doc, clientId: number): CollaboratorInfo | null {
  return checkoutCollaboratorsMap(doc).get(String(clientId)) ?? null;
}

export function checkoutMetaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("meta");
}

export function checkoutBaseCommit(doc: Y.Doc): string | undefined {
  const value = checkoutMetaMap(doc).get("baseCommit");
  return typeof value === "string" ? value : undefined;
}

export function checkoutBaseContents(doc: Y.Doc): Record<string, string> {
  const value = checkoutMetaMap(doc).get("base");
  return typeof value === "object" && value !== null ? (value as Record<string, string>) : {};
}

/** Plain-string view of the collaborative files map. */
export function checkoutFileContents(doc: Y.Doc): Record<string, string> {
  const contents: Record<string, string> = {};
  checkoutFilesMap(doc).forEach((text, path) => {
    contents[path] = text.toString();
  });
  return contents;
}

/**
 * The checkout's uncommitted changes: its files versus the base snapshot.
 * Same A/M/D vocabulary the commit UI already speaks; titles prefer live
 * content, base content for pure deletions.
 */
export function checkoutTaskChanges(
  files: Readonly<Record<string, string>>,
  base: Readonly<Record<string, string>>,
): TaskChangeSummary[] {
  const changes: TaskChangeSummary[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (!isTaskFilePath(path)) continue;
    const baseContent = base[path];
    if (baseContent === content) continue;
    changes.push({
      path,
      status: baseContent === undefined ? "added" : "modified",
      title: parseTaskCard(path, content).title,
    });
  }
  for (const [path, content] of Object.entries(base)) {
    if (!isTaskFilePath(path) || path in files) continue;
    changes.push({ path, status: "deleted", title: parseTaskCard(path, content).title });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

/** The `commitFiles` batch for a checkout's diff against base. */
export function checkoutRepoChanges(
  files: Readonly<Record<string, string>>,
  base: Readonly<Record<string, string>>,
): RepoFileChange[] {
  const changes: RepoFileChange[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (base[path] !== content) changes.push({ path, content });
  }
  for (const path of Object.keys(base)) {
    if (!(path in files)) changes.push({ path, delete: true });
  }
  return changes;
}

/**
 * Rewrite a Y.Text to `next` as one minimal splice (common prefix/suffix
 * preserved) so concurrent edits elsewhere in the file survive the merge —
 * a whole-text replace would stomp every other collaborator's characters.
 */
export function applyTextEdit(text: Y.Text, next: string): void {
  const current = text.toString();
  if (current === next) return;
  let start = 0;
  const shortest = Math.min(current.length, next.length);
  while (start < shortest && current[start] === next[start]) start++;
  let currentEnd = current.length;
  let nextEnd = next.length;
  while (currentEnd > start && nextEnd > start && current[currentEnd - 1] === next[nextEnd - 1]) {
    currentEnd--;
    nextEnd--;
  }
  const transact = () => {
    if (currentEnd > start) text.delete(start, currentEnd - start);
    if (nextEnd > start) text.insert(start, next.slice(start, nextEnd));
  };
  if (text.doc) text.doc.transact(transact);
  else transact();
}

/** The repo a checkout edits when none is picked. */
export const DEFAULT_REPO_PATH = "/repos/config";

/**
 * A checkout's repo path must be a clean `/repos/...` path — it becomes part
 * of a Durable Object name and a git-API target, so reject anything with
 * empty, dotted, or exotic segments. Returns null when invalid.
 */
export function normalizeRepoPath(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return DEFAULT_REPO_PATH;
  if (!value.startsWith("/repos/")) return null;
  const segments = value.slice(1).split("/");
  if (segments.length < 2) return null;
  for (const segment of segments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) return null;
  }
  return value;
}

/** Shareable checkout id: date-time prefix for humans, random tail for uniqueness. */
export function newCheckoutId(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const tail = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${tail}`;
}

export function isCheckoutId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}
