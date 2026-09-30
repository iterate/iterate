// THE TREE the dash navigates — the signed-in person → their organizations → each organization's
// projects — READ FROM /api: `organizations.list()` and `projects.list()`, the control plane's
// database as it stands (core/os src/session.ts). The streams are activity logs: a fact landing on
// the person's account (a membership of theirs) or on an organization's own context (renamed, a
// member, an invitation, a project) only INVALIDATES the read, and the tree reads again. ONE
// subscription per organization and one for the account, never one per project (every open
// subscription is a row and a pinned Durable Object).
// `<OrganizationTree>` is mounted once by the shell and renders nothing; it publishes the tree it
// reads, and the nav, the switcher, the breadcrumbs and every page read the same tree through
// `useOrganizationTree()` — a route's `beforeLoad`, which cannot use a hook, through
// `readOrganizationTree()`. A page that made a write awaits `reloadOrganizationTree()` before it
// relies on the tree: the fact that would say so lands after the answer. An organization's members
// and invitation links are its page's own read (routes/_auth/organizations/$orgId.tsx), again
// whenever the tree reads again (`revision`).
// oxlint-disable react/only-export-components -- the tree's hook and its loader-side reads are the component's own API: one file, one place.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AuthenticatedApp } from "iterate/app";
import { useContextStub } from "iterate/react";

export type OrganizationRole = "owner" | "member";
type TreeProject = { id: string; slug: string; orgId: string };
export type TreeOrganization = {
  id: string;
  name: string;
  /** the person's role; none for an organization the session reaches only through a project */
  role?: OrganizationRole;
  /** oldest first */
  projects: TreeProject[];
};
type OrganizationTreeState = {
  /** the first read answered (or failed) */
  loaded: boolean;
  /** oldest first */
  organizations: TreeOrganization[];
  /** every organization's projects, in the organizations' order */
  projects: TreeProject[];
  /** the last read failed: the tree is the one before it */
  error?: string;
  /** how many reads have answered — what a page's own read of an organization follows */
  revision: number;
};

const EMPTY: OrganizationTreeState = {
  loaded: false,
  organizations: [],
  projects: [],
  revision: 0,
};

// ── the store: what the mounted `<OrganizationTree>` last published ──
let published = EMPTY;
const listeners = new Set<() => void>();
function publish(tree: OrganizationTreeState) {
  published = tree;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── the reads: one in flight; asked for meanwhile, one more after it ──
type Api = AuthenticatedApp["api"];
/** the mounted tree's session; null while none is mounted */
let reader: Api | null = null;
/** reads asked for, and the last ask a read answered (a read answers every ask before it began) */
let asked = 0;
let answered = 0;
let reading = false;
let waiting: { ask: number; resolve: () => void }[] = [];

/** Resolve the waits for every ask through `ask`. */
function settle(ask: number) {
  for (const wait of waiting) if (wait.ask <= ask) wait.resolve();
  waiting = waiting.filter((wait) => wait.ask > ask);
}

async function read() {
  if (reading) return;
  reading = true;
  try {
    while (reader && answered < asked) {
      const api = reader;
      const through = asked;
      try {
        const [orgs, projects] = await Promise.all([api.organizations.list(), api.projects.list()]);
        if (reader === api) publish(treeOf(orgs, projects, published.revision + 1));
      } catch (caught) {
        if (reader === api)
          publish({
            ...published,
            loaded: true,
            error: caught instanceof Error ? caught.message : String(caught),
            revision: published.revision + 1,
          });
      }
      answered = through;
      settle(through);
    }
  } finally {
    reading = false;
  }
}

/** The tree from the session's lists. A project whose organization the session does not list (a
 *  grant bound to projects) sits under the organization's id. */
function treeOf(
  orgs: { id: string; name: string; role?: OrganizationRole }[],
  projects: TreeProject[],
  revision: number,
): OrganizationTreeState {
  const ids = [
    ...new Set([...orgs.map((org) => org.id), ...projects.map((project) => project.orgId)]),
  ];
  const organizations = ids.map((id): TreeOrganization => {
    const org = orgs.find((candidate) => candidate.id === id);
    return {
      id,
      name: org?.name || id,
      role: org?.role,
      projects: projects
        .filter((project) => project.orgId === id)
        .map(({ id: projectId, slug, orgId }) => ({ id: projectId, slug, orgId })),
    };
  });
  return {
    loaded: true,
    organizations,
    projects: organizations.flatMap((org) => org.projects),
    revision,
  };
}

/** Read the tree again: after a write of this page's own, awaited before a navigation that relies
 *  on it; and whenever a fact says it changed. Resolves once a read that started after the call
 *  has answered (at once when no tree is mounted). */
export function reloadOrganizationTree() {
  if (!reader) return Promise.resolve();
  const ask = ++asked;
  const answeredAsk = new Promise<void>((resolve) => waiting.push({ ask, resolve }));
  void read();
  return answeredAsk;
}

/** The tree as every component reads it; re-renders as it changes. */
export function useOrganizationTree(): OrganizationTreeState {
  return useSyncExternalStore(
    subscribe,
    () => published,
    () => published,
  );
}
/** The tree as a route's `beforeLoad` reads it — a snapshot: empty and not loaded before the shell
 *  has mounted it (a fresh page load), so a loader that needs a row falls back to the catalog. */
export function readOrganizationTree(): OrganizationTreeState {
  return published;
}

/** One organization of the tree, by id — `org` when the tree lists it; `missing` once a read has
 *  answered without it. Before the first read, and while the last read failed, neither: the tree a
 *  failed read leaves lacks an organization written a moment ago, so the page shows `error`, not a
 *  404. */
export function useOrganizationTreeEntry(orgId: string) {
  const tree = useOrganizationTree();
  const org = tree.organizations.find((candidate) => candidate.id === orgId);
  return { org, missing: !org && tree.loaded && !tree.error, error: tree.error };
}

/** The facts that change the tree: a membership of the person's, on their account; anything that
 *  happens to an organization, on its own context (core/os src/organization/contract.ts). */
const ACCOUNT_FACTS = [
  "events.iterate.com/organization/member-added",
  "events.iterate.com/organization/member-removed",
];
const ORGANIZATION_FACTS = [
  "events.iterate.com/organization/renamed",
  "events.iterate.com/organization/deleted",
  "events.iterate.com/organization/member-added",
  "events.iterate.com/organization/member-removed",
  "events.iterate.com/organization/invitation-created",
  "events.iterate.com/organization/invitation-accepted",
  "events.iterate.com/organization/invitation-revoked",
  "events.iterate.com/organization/project-added",
  "events.iterate.com/organization/project-removed",
];

/** Mounted once, by the shell: reads the tree, and again on every fact the person's account and
 *  each organization's context take. Renders nothing. */
export function OrganizationTree({ api, info }: { api: Api; info: AuthenticatedApp["info"] }) {
  useEffect(() => {
    reader = api;
    void reloadOrganizationTree();
    return () => {
      // this session's tree goes with it; a wait for it is over
      reader = null;
      settle(asked);
      publish(EMPTY);
    };
  }, [api]);
  const invalidate = useCallback(() => void reloadOrganizationTree(), []);
  const tree = useOrganizationTree();
  // the account opens only with the `account` scope; a grant bound to projects is refused it
  // (FORBIDDEN), and follows its organizations alone
  const account = useContextStub(
    info.scopes.includes("account") ? () => Promise.resolve(api.user) : null,
    [api, info.scopes],
  );
  return (
    <>
      <Facts stub={account.stub} consumes={ACCOUNT_FACTS} onFact={invalidate} />
      {tree.organizations.map((org) => (
        <OrganizationFacts key={org.id} api={api} orgId={org.id} onFact={invalidate} />
      ))}
    </>
  );
}

/** One organization's context, held for as long as the tree lists it, and its facts. */
function OrganizationFacts({
  api,
  orgId,
  onFact,
}: {
  api: Api;
  orgId: string;
  onFact: () => void;
}) {
  const context = useContextStub(() => api.organizations.get(orgId), [api, orgId]);
  return <Facts stub={context.stub} consumes={ORGANIZATION_FACTS} onFact={onFact} />;
}

type FactContext = {
  subscribe(input: {
    consumes: string[];
    target: (events: unknown[]) => void;
  }): Promise<{ [Symbol.dispose](): void }>;
};

/** A subscription to `consumes` on a held context: `onFact` on every batch it pushes, and once as
 *  it opens — a fact that landed before it did is read with it. A subscription refused leaves the
 *  tree as it is: it reads again on the next fact, or the next write. Renders nothing. */
function Facts({
  stub,
  consumes,
  onFact,
}: {
  stub: FactContext | undefined;
  consumes: string[];
  onFact: () => void;
}) {
  useEffect(() => {
    if (!stub) return;
    let disposed = false;
    let handle: { [Symbol.dispose](): void } | undefined;
    stub.subscribe({ consumes, target: () => !disposed && onFact() }).then(
      (opened) => {
        if (disposed) return opened[Symbol.dispose]();
        handle = opened;
        onFact();
      },
      (caught: unknown) => console.warn("organization tree: a subscription was refused", caught),
    );
    return () => {
      disposed = true;
      handle?.[Symbol.dispose]();
    };
  }, [stub, consumes, onFact]);
  return null;
}
