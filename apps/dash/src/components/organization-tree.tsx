// THE TREE the dash navigates — the signed-in person → their organizations → each organization's
// projects — read from LIVE STATE, not listed: which organizations the person belongs to is the
// account fold on `session.user` (`memberships`, apps/os/src/account/contract.ts); what an
// organization is called, who belongs to it and which projects it holds is the organization fold on
// `session.organizations.get(orgId)` (apps/os/src/organization/contract.ts). ONE subscription per
// organization and one for the account, never one per project (every open live state is a
// subscription row and a pinned Durable Object): a project's own live state opens on its page alone.
// `<OrganizationTree>` is mounted once by the shell and renders nothing; it publishes the tree it
// folds, and the nav, the switcher, the breadcrumbs and every page read the same tree through
// `useOrganizationTree()` — a route's `beforeLoad`, which cannot use a hook, through
// `readOrganizationTree()`.
//
// A session that cannot open the account — `account` unticked at consent, or a grant bound to
// projects (a personal access token), which `api.user` refuses FORBIDDEN — gets the LISTED tree
// instead: `organizations.list()` and `projects.list()`, read once, and again on
// `reloadOrganizationTree()` after a write; it carries no members.
// oxlint-disable react/only-export-components -- the tree's hook and its loader-side reads are the component's own API: one file, one place.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import type { AuthenticatedApp } from "iterate/next/app";
import { useContextStub, useFacetLiveState } from "../lib/context-stub.ts";

export type OrganizationRole = "owner" | "member";
type TreeProject = {
  id: string;
  slug: string;
  orgId: string;
  /** when the organization's record says it was created; null in the listed tree */
  createdAt: string | null;
};
export type TreeOrganization = {
  id: string;
  /** the name as the organization's record last folded it — its id until the first fact lands */
  name: string;
  /** the person's role, from the account's memberships (the listed tree: the session's row) */
  role?: OrganizationRole;
  /** who belongs, by user id — the organization's record; empty in the listed tree */
  members: Record<string, { role: OrganizationRole; since: string }>;
  /** in creation order */
  projects: TreeProject[];
  /** the organization's live state: connecting, live, or failed — `error` says how */
  status: "connecting" | "live" | "error";
  error?: string;
};
type OrganizationTreeState = {
  /** live: the account's memberships and every organization's record, pushed as they change;
   *  listed: the session's lists, read once */
  source: "live" | "listed";
  /** the memberships are known and every organization has answered (or failed) */
  loaded: boolean;
  /** in membership order — the organization joined first, first */
  organizations: TreeOrganization[];
  /** every organization's projects, in the organizations' order */
  projects: TreeProject[];
  /** the account's live state (or the lists) could not be read */
  error?: string;
};

const EMPTY: OrganizationTreeState = {
  source: "live",
  loaded: false,
  organizations: [],
  projects: [],
};

// ── the store: what the mounted `<OrganizationTree>` last published ──
let published: OrganizationTreeState = EMPTY;
const listeners = new Set<() => void>();
let reload: () => void = () => {};
function publish(tree: OrganizationTreeState) {
  published = tree;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
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
/** How long a page waits for an organization the loaded tree does not list yet: a creation answers
 *  before the account's live-state push lands in this client, so the tree is `loaded` and the
 *  organization absent for a moment. After the grace it is missing. */
const ORGANIZATION_GRACE_MS = 8_000;

/** One organization of the tree, by id — `org` when the tree lists it; `missing` once the tree is
 *  loaded, has waited the grace, and still does not. Until then, neither: the page is pending. */
export function useOrganizationTreeEntry(orgId: string): {
  org: TreeOrganization | undefined;
  missing: boolean;
} {
  const tree = useOrganizationTree();
  const org = tree.organizations.find((candidate) => candidate.id === orgId);
  // the organization whose grace ran out — keyed, so the next organization gets its own grace
  const [graceOverFor, setGraceOverFor] = useState<string | null>(null);
  useEffect(() => {
    if (org || !tree.loaded) return;
    const timer = setTimeout(() => setGraceOverFor(orgId), ORGANIZATION_GRACE_MS);
    return () => clearTimeout(timer);
  }, [org, tree.loaded, orgId]);
  return { org, missing: !org && tree.loaded && graceOverFor === orgId };
}

/** The listed tree reads its lists again (after a create); the live tree already has it. */
export function reloadOrganizationTree(): void {
  reload();
}

type Api = AuthenticatedApp["api"];

const Membership = z.object({ role: z.enum(["owner", "member"]), since: z.string() });
/** The account fold, the one field the tree reads. */
const AccountLive = z.looseObject({ memberships: z.record(z.string(), Membership).default({}) });
/** The organization fold, the fields the tree reads. */
const OrganizationLive = z.looseObject({
  name: z.string().nullable().default(null),
  members: z.record(z.string(), Membership).default({}),
  projects: z.record(z.string(), z.object({ slug: z.string(), createdAt: z.string() })).default({}),
});

/** Mounted once, by the shell: opens the account's live state — or, for a session that cannot,
 *  lists — and publishes the tree. Renders nothing. */
export function OrganizationTree({ api, info }: { api: Api; info: AuthenticatedApp["info"] }) {
  // each session (or scope set) opens its own account. `api.user` is pipelined: the round trip is
  // the await, and a grant bound to projects rejects it (FORBIDDEN) — the listed tree then, as for
  // a session without `account`
  const account = useContextStub(
    info.scopes.includes("account") ? () => Promise.resolve(api.user) : null,
    [api, info.scopes],
  );
  useEffect(() => () => publish(EMPTY), []);
  if (account.pending) return null;
  return account.stub ? <LiveTree api={api} user={account.stub} /> : <ListedTree api={api} />;
}

/** One organization's live state as its branch reports it up. */
type Branch = { value: unknown; status: "connecting" | "live" | "error"; error?: string };

/** A global context stub the session vends — `api.user`, `api.organizations.get(orgId)`. */
type GlobalContext = Awaited<Api["user"]>;

/** The live tree: the account's memberships, and a branch per membership. */
function LiveTree({ api, user }: { api: Api; user: GlobalContext }) {
  const account = useFacetLiveState(user, "account");
  const memberships = useMemo(
    () => AccountLive.safeParse(account.value).data?.memberships ?? {},
    [account.value],
  );
  const [branches, setBranches] = useState<Record<string, Branch>>({});
  const report = useCallback((orgId: string, branch: Branch | null) => {
    setBranches((previous) => {
      if (branch) return { ...previous, [orgId]: branch };
      const { [orgId]: _gone, ...rest } = previous;
      return rest;
    });
  }, []);
  // the organization joined first, first; the id breaks a tie
  const orgIds = useMemo(
    () =>
      Object.entries(memberships)
        .sort(([idA, a], [idB, b]) => a.since.localeCompare(b.since) || idA.localeCompare(idB))
        .map(([id]) => id),
    [memberships],
  );
  const tree = useMemo((): OrganizationTreeState => {
    const organizations = orgIds.map((id): TreeOrganization => {
      const branch = branches[id];
      const record =
        branch?.value === undefined ? undefined : OrganizationLive.safeParse(branch.value).data;
      return {
        id,
        name: record?.name || id,
        role: memberships[id]?.role,
        members: record?.members ?? {},
        projects: Object.entries(record?.projects ?? {})
          .sort(
            ([idA, a], [idB, b]) =>
              a.createdAt.localeCompare(b.createdAt) || idA.localeCompare(idB),
          )
          .map(([projectId, project]) => ({
            id: projectId,
            slug: project.slug,
            orgId: id,
            createdAt: project.createdAt,
          })),
        status: branch?.status ?? "connecting",
        error: branch?.error,
      };
    });
    const seeded = account.value !== undefined || account.status === "error";
    // an organization that failed before its live state ever answered holds no projects we know
    // of — the tree says so rather than reading as "none" (a failure after it answered keeps the
    // last state)
    const unread = orgIds.find(
      (id) => branches[id]?.status === "error" && branches[id].value === undefined,
    );
    return {
      source: "live",
      loaded: seeded && organizations.every((org) => org.status !== "connecting"),
      organizations,
      projects: organizations.flatMap((org) => org.projects),
      error:
        account.value === undefined
          ? account.error
          : unread && `The organization ${unread} did not load: ${branches[unread]!.error}`,
    };
  }, [orgIds, branches, memberships, account.value, account.status, account.error]);
  useEffect(() => publish(tree), [tree]);
  // this account's tree goes with it: a new session's (or the listed one) publishes its own
  useEffect(() => () => publish(EMPTY), []);
  return orgIds.map((orgId) => (
    <OrganizationBranch key={orgId} api={api} orgId={orgId} report={report} />
  ));
}

/** One membership: the organization's context, held for the branch's life, and its live state,
 *  reported up. Renders nothing. */
function OrganizationBranch({
  api,
  orgId,
  report,
}: {
  api: Api;
  orgId: string;
  report: (orgId: string, branch: Branch | null) => void;
}) {
  const context = useContextStub(() => api.organizations.get(orgId), [api, orgId]);
  const live = useFacetLiveState(context.stub, "organization");
  useEffect(() => {
    report(orgId, {
      value: live.value,
      status: context.error ? "error" : live.status,
      error: context.error || live.error,
    });
  }, [orgId, report, live.value, live.status, live.error, context.error]);
  useEffect(() => () => report(orgId, null), [orgId, report]);
  return null;
}

/** The listed tree — the session's lists, read once and on `reloadOrganizationTree()`. */
function ListedTree({ api }: { api: Api }) {
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    reload = () => setGeneration((previous) => previous + 1);
    return () => {
      reload = () => {};
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    Promise.all([api.organizations.list(), api.projects.list()]).then(
      ([orgs, projects]) => {
        if (disposed) return;
        // a project whose organization the session does not list sits under the organization's id
        const ids = [
          ...new Set([...orgs.map((org) => org.id), ...projects.map((project) => project.orgId)]),
        ];
        const organizations = ids.map((id): TreeOrganization => {
          const org = orgs.find((candidate) => candidate.id === id);
          return {
            id,
            name: org?.name || id,
            role: org?.role,
            members: {},
            projects: projects
              .filter((project) => project.orgId === id)
              .map((project) => ({ ...project, createdAt: null })),
            status: "live",
          };
        });
        publish({
          source: "listed",
          loaded: true,
          organizations,
          projects: organizations.flatMap((org) => org.projects),
        });
      },
      (caught: unknown) =>
        !disposed &&
        publish({
          ...EMPTY,
          source: "listed",
          loaded: true,
          error: caught instanceof Error ? caught.message : String(caught),
        }),
    );
    return () => {
      disposed = true;
    };
  }, [api, generation]);
  return null;
}
