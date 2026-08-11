import {
  formatConfigRepoTemplateReference,
  type ConfigRepoTemplateReference,
} from "./config-repo-template-reference.ts";

/**
 * The `-template-<name>` slug convention: a project slug carrying a template
 * name gets born from `configs/<name>` in the canonical template repository,
 * without the creator ever seeing a template field. This is what makes a
 * PR-body login link (`?project_hint=pr2477-template-waiter-chef`) end in a
 * project running that PR's template — see docs/dev-environments.md.
 *
 * The templates always come from the platform's own public monorepo; a
 * different repo still needs the explicit configRepoTemplate argument.
 */
const CANONICAL_TEMPLATE_REPOSITORY = { owner: "iterate", repo: "iterate" };

/**
 * Parse the convention out of a slug. The FIRST `-template-` splits prefix
 * from template name; a `pr<digits>` prefix pins the ref to that pull
 * request's head (`pull/<N>/head` — a plain git ref the template downloader's
 * `commits/{ref}` lookup resolves), so in-flight template PRs are testable.
 * Any other prefix leaves the ref unset and the downloader's HEAD default
 * (the default branch) applies. Null when the slug doesn't use the
 * convention.
 */
export function configRepoTemplateFromSlug(slug: string): string | null {
  const match = /^(.+?)-template-([a-z0-9][a-z0-9-]*)$/.exec(slug);
  if (match === null) return null;
  const [, prefix, templateName] = match;
  // The prefix only needs to START with pr<N> — `pr2477-alice-template-x`
  // still pins to PR 2477, so several people can demo one PR's template
  // without fighting over a single slug.
  const pullRequest = /^pr(\d{1,7})(?:-|$)/.exec(prefix!);
  const reference: ConfigRepoTemplateReference = {
    ...CANONICAL_TEMPLATE_REPOSITORY,
    path: `configs/${templateName}`,
    ...(pullRequest === null ? {} : { ref: `pull/${pullRequest[1]}/head` }),
  };
  return formatConfigRepoTemplateReference(reference);
}

/**
 * The convention's existence gate: only a template folder GitHub can list
 * turns the slug into a template birth — a slug that merely LOOKS like the
 * convention (or names a template that never landed) produces an ordinary
 * stock project rather than a failed one. Network/rate-limit failures count
 * as "missing" too (creation must not depend on GitHub being reachable);
 * the caller logs the downgrade.
 */
/**
 * The one-call form create() uses: parse the convention, gate on existence,
 * log which way it went. Undefined = ordinary stock project.
 */
export async function resolveSlugConventionTemplate(slug: string): Promise<string | undefined> {
  const derived = configRepoTemplateFromSlug(slug);
  if (derived === null) return undefined;
  if (await slugConfigTemplateExists(derived)) {
    console.log("[project-create] slug template convention resolved", {
      slug,
      configRepoTemplate: derived,
    });
    return derived;
  }
  console.warn(
    "[project-create] slug names a config template that does not exist; creating without one",
    { slug, configRepoTemplate: derived },
  );
  return undefined;
}

export async function slugConfigTemplateExists(
  templateReference: string,
  githubFetch: (url: string, init: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<boolean> {
  const match = /^github:([^/]+)\/([^#]+)#(?:(.+)&)?path:(.+)$/.exec(templateReference);
  if (match === null) return false;
  const [, owner, repo, ref, path] = match;
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/contents/${path}`,
  );
  if (ref !== undefined) url.searchParams.set("ref", ref);
  try {
    const response = await githubFetch(url.toString(), {
      headers: { "User-Agent": "iterate-os", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
