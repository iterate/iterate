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
 * The one-call form create() uses: parse the convention, gate on existence,
 * log which way it went. Undefined = ordinary stock project — but ONLY when
 * GitHub definitively says the template folder is absent. A rate-limited or
 * unreachable GitHub errs toward recording the template: the slug explicitly
 * asked for one, and a visible seed failure the user can retry beats
 * silently birthing a stock project that looks like the feature not working
 * (observed live: a 403-limited existence check on preview-14 quietly
 * produced a guestbook project from a waiter-chef link).
 */
export async function resolveSlugConventionTemplate(slug: string): Promise<string | undefined> {
  const derived = configRepoTemplateFromSlug(slug);
  if (derived === null) return undefined;
  const existence = await checkSlugConfigTemplate(derived);
  if (existence === "missing") {
    console.warn(
      "[project-create] slug names a config template that does not exist; creating without one",
      { slug, configRepoTemplate: derived },
    );
    return undefined;
  }
  if (existence === "unknown") {
    console.warn(
      "[project-create] could not verify the slug's config template (rate limit or outage); recording it anyway — the repo seed will surface a definitive failure",
      { slug, configRepoTemplate: derived },
    );
  } else {
    console.log("[project-create] slug template convention resolved", {
      slug,
      configRepoTemplate: derived,
    });
  }
  return derived;
}

export async function checkSlugConfigTemplate(
  templateReference: string,
  githubFetch: (url: string, init: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<"exists" | "missing" | "unknown"> {
  const match = /^github:([^/]+)\/([^#]+)#(?:(.+)&)?path:(.+)$/.exec(templateReference);
  if (match === null) return "missing";
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
    if (response.ok) return "exists";
    // 404 is GitHub's definitive "no such folder at that ref"; everything
    // else (403 rate limit, 5xx) proves nothing about the template.
    return response.status === 404 ? "missing" : "unknown";
  } catch {
    return "unknown";
  }
}
