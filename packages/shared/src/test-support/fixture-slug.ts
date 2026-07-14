/**
 * The naming convention for disposable test fixtures (projects, orgs) minted
 * by the e2e and Playwright lanes: `<prefix>-<base36 timestamp>-<uuid slice>`.
 *
 * Project slugs become DNS labels (`<slug>.iterate-preview-N.app`,
 * `<slug>.localhost`), so the result is lowercased, double dashes are
 * collapsed, and callers that take arbitrary prefixes should pass
 * `maxPrefixLength` to stay under label length limits. The timestamp keeps
 * leaked fixtures attributable/sortable: there is no `projects.remove` on itx
 * yet, so disposal is a no-op and stages accumulate fixtures until reset.
 */
export function uniqueFixtureSlug(prefix: string, opts?: { maxPrefixLength?: number }): string {
  const trimmedPrefix =
    opts?.maxPrefixLength === undefined ? prefix : prefix.slice(0, opts.maxPrefixLength);
  return `${trimmedPrefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
    .toLowerCase()
    .replace(/-{2,}/g, "-");
}
