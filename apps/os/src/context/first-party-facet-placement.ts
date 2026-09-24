// context/first-party-facet-placement.ts — WHERE A FACET MAY BE HOSTED AND CODE MAY BE LOADED, pure
// (no I/O). A first-party facet (first-party-facets.ts) is this worker's own class, minted from
// `ctx.exports` with the worker's REAL env (APP_CONFIG, the at-rest key, every binding) and a
// loopback to the context that hosts it — so that context is its authority, and it is hosted only
// where the platform's own code hosts it, never wherever a caller reaches `itx.facets.get(name)` (a
// signed-in person reaches their own `global:/users/<id>`, their organizations and every path of
// their projects). Loaded code — a person's own source — runs only inside a project. Enforced where
// every facet is created, context/facet-host.ts `FacetHost#callFacet`; where every stateless worker is
// loaded, context/built-ins.ts `workers.get` (`itx.run`'s script loads there too); and before a
// hosting row is appended, built-ins.ts `processors.enable`. A context is `(projectId, path)`, the
// path canonical (paths.ts `DurableObjectNameCodec`), its owner root `resourceScope`'s (paths.ts).
// THE RULES, rows of the table test beside this file:
//   1. `account` — a user's own context, `global:/users/<id>`, and nowhere else: where the person's
//      facts land (session.ts `publishPlatformFacts`, grants.ts, consent.ts) and a user's secrets
//      catalog is folded (built-ins.ts `ownerRootFacet`).
//   2. `organization` — an organization's own context, `global:/organizations/<id>`, and nowhere
//      else: session.ts `foldPlatformFacts` (created, renamed, deleted, a project created in it) and
//      the organization's secrets catalog (built-ins.ts `ownerRootFacet`).
//   3. `project` — a project's root `/`, and nowhere else: its creation saga (session.ts
//      `projects.create`), the entity collections (library.ts `projectFacet`) and the project's
//      secrets catalog (built-ins.ts `ownerRootFacet`).
//   4. `secret` — `/secrets/<name>` directly under its owner's root, the one context `itx.secrets`
//      and egress resolve a secret to (built-ins.ts `onSecretContext`, the DO's `#egress`): a
//      project's `/secrets/<name>`, a user's `global:/users/<id>/secrets/<name>`, an organization's
//      `global:/organizations/<id>/secrets/<name>`. The global root owns no secrets.
//   5. `repo`, `workspace` — any context of a project: `itx.repos.create(path)` and
//      `itx.workspaces.create(path)` take any path (library.ts `entityRoot`; `/repos/<name>` is a
//      convention, not a rule). Never the global namespace.
//   6. Loaded code — a facet or processor of any other name, hosted from the source its spec names,
//      and a stateless worker, `itx.workers.get({ source })` (which `itx.run` loads its script
//      through) — runs only inside a project, any of its contexts, and never in the global
//      namespace: a person's account, an organization and the global root run the platform's code
//      alone.
import { codedError } from "iterate/lib";
import type { FIRST_PARTY_FACET_CLASSES } from "../first-party-facets.ts";
import { SECRET_PATH } from "../secrets.ts";
import { GLOBAL_PROJECT_ID, pathUnderOwner, resourceScope } from "./paths.ts";

/** A context as the rules read it: the project it belongs to and its canonical path. */
type IterateContextAddress = { projectId: string; path: string };

/** Each first-party facet's rule: where it may be hosted, in words (the refusal names it) and as a
 *  predicate. A first-party name without a rule fails to typecheck. */
const FIRST_PARTY_FACET_PLACEMENT_RULES = {
  // 1.
  account: {
    where: "a user's own context, global:/users/<id>",
    mayBeHostedOn: ({ projectId, path }) =>
      projectId === GLOBAL_PROJECT_ID &&
      path.startsWith("/users/") &&
      path === resourceScope(projectId, path).rootPath,
  },
  // 2.
  organization: {
    where: "an organization's own context, global:/organizations/<id>",
    mayBeHostedOn: ({ projectId, path }) =>
      projectId === GLOBAL_PROJECT_ID &&
      path.startsWith("/organizations/") &&
      path === resourceScope(projectId, path).rootPath,
  },
  // 3.
  project: {
    where: 'a project\'s root, "/"',
    mayBeHostedOn: ({ projectId, path }) => projectId !== GLOBAL_PROJECT_ID && path === "/",
  },
  // 4. The path relative to the owner's root is what the placeholder spells — the secret facet's
  // own `#address` (secret/durable-object.ts).
  secret: {
    where: "/secrets/<name> directly under a project's, a user's or an organization's root",
    mayBeHostedOn: ({ projectId, path }) => {
      const owner = resourceScope(projectId, path);
      if (owner.kind === "global") return false;
      return SECRET_PATH.test(pathUnderOwner(owner, path));
    },
  },
  // 5.
  repo: {
    where: "a project's context",
    mayBeHostedOn: ({ projectId }) => projectId !== GLOBAL_PROJECT_ID,
  },
  workspace: {
    where: "a project's context",
    mayBeHostedOn: ({ projectId }) => projectId !== GLOBAL_PROJECT_ID,
  },
} satisfies Record<
  keyof typeof FIRST_PARTY_FACET_CLASSES,
  { where: string; mayBeHostedOn: (context: IterateContextAddress) => boolean }
>;

/** Refuses — FORBIDDEN, which a hosting row's delivery halts on at once — hosting the facet `name`
 *  on `context` where the rules above do not place it: a first-party name by its own rule (1–5), any
 *  other name as loaded code (6). */
export function assertFacetPlacement(name: string, context: IterateContextAddress): void {
  if (!Object.hasOwn(FIRST_PARTY_FACET_PLACEMENT_RULES, name))
    return assertLoadedCodePlacement(`facet "${name}"`, context);
  // `hasOwn` just proved `name` one of the table's keys, which the type system cannot see.
  const rule =
    FIRST_PARTY_FACET_PLACEMENT_RULES[name as keyof typeof FIRST_PARTY_FACET_PLACEMENT_RULES];
  if (rule.mayBeHostedOn(context)) return;
  throw codedError(
    "FORBIDDEN",
    `facet "${name}" is first-party and is hosted only on ${rule.where} — never on ${context.projectId}:${context.path}`,
  );
}

/** Refuses — FORBIDDEN — loading code on `context` outside a project (rule 6). `loadedAs` names the
 *  call in the refusal: `facet "<name>"`, `workers.get`. */
export function assertLoadedCodePlacement(loadedAs: string, context: IterateContextAddress): void {
  if (context.projectId !== GLOBAL_PROJECT_ID) return;
  throw codedError(
    "FORBIDDEN",
    `${loadedAs}: loaded code runs only in a project — never in the global namespace (${context.projectId}:${context.path})`,
  );
}
