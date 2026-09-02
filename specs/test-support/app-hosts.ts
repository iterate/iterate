/**
 * Project app hosts, as a browser reaches them: `<app>--<project>.<base>`,
 * one origin per app. Locally the base is the dev server's `.localhost` port
 * (Chromium resolves `*.localhost` to loopback natively — no Host-header
 * tricks needed, unlike Node fetch); deployed runs read the wildcard base
 * from APP_CONFIG_PROJECT_HOSTNAME_BASES with the same preview-hostname
 * fallback as the ingress e2e.
 */
export function appUrl(appSlug: string, projectSlug: string, baseURL: string) {
  const base = new URL(baseURL);
  if (base.hostname === "localhost" || base.hostname.endsWith(".localhost")) {
    return `${base.protocol}//${appSlug}--${projectSlug}.localhost${base.port ? `:${base.port}` : ""}/`;
  }
  const raw = process.env.APP_CONFIG_PROJECT_HOSTNAME_BASES?.trim();
  const configuredBase = raw ? String((JSON.parse(raw) as string[])[0]) : undefined;
  const previewMatch = /^os\.(iterate-preview-\d+)\.com$/.exec(base.hostname);
  const projectBase = configuredBase || (previewMatch ? `${previewMatch[1]}.app` : base.hostname);
  return `${base.protocol}//${appSlug}--${projectSlug}.${projectBase}/`;
}

/**
 * The Docs vessel a project's config worker should proxy to for this OS
 * deployment — the deployed docs worker of the same preview slot or of
 * production. Local dev has no deployed vessel: run apps/docs through a
 * captun tunnel and pass its HTTPS origin as DOCS_APP_ORIGIN
 * (docs/remote-apps.md — the config worker only proxies to HTTPS origins).
 */
export function docsOriginForBaseUrl(baseURL: string): string {
  const override = process.env.DOCS_APP_ORIGIN?.trim();
  if (override) return override.replace(/\/+$/, "");
  const previewMatch = /^os\.iterate-preview-(\d+)\.com$/.exec(new URL(baseURL).hostname);
  if (previewMatch) {
    return `https://docs-preview-${previewMatch[1]}.iterate-dev-preview.workers.dev`;
  }
  if (new URL(baseURL).hostname === "os.iterate.com") return "https://docs.iterate.workers.dev";
  throw new Error("DOCS_APP_ORIGIN is required when running the Docs app spec outside preview.");
}
