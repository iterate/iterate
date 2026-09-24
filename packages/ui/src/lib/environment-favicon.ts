/**
 * Which deployment a page is on, told apart in the browser tab: a per-PR preview gets a purple icon
 * with its PR number and a `[pr<N>]` title prefix, local dev a teal icon and `[dev]`, and
 * production keeps the app's own plain logo and its titles untouched. Restored from #2197 (the old
 * OS's environment favicons, lost with that platform in #2837) and extended to every client.
 *
 * Read from the page's own hostname, the one fact the Worker, the server render and the browser
 * all agree on, so no env var or config carries it (envs.ts names the hosts):
 * - `pr<N>-<worker>.<subdomain>.workers.dev`: a per-PR Worker Preview (apps/os/scripts/preview.ts)
 * - `localhost`, `*.localhost`, `127.0.0.1`: `pnpm dev`
 * - anything else: production (os.iterate.com, dash.iterate.com, agents.iterate.com, …)
 *
 * Rendered by components/environment-head-content.tsx in every client's root, and by the OS's
 * `/favicon.svg` (apps/os/src/issuer-pages.ts), which the SDK's gate pages link.
 */
export function deploymentEnvironment(hostname: string) {
  const preview = /^pr(\d+)-[^.]+\.[^.]+\.workers\.dev$/.exec(hostname);
  if (preview) return { kind: "preview" as const, pr: Number(preview[1]) };
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1")
    return { kind: "dev" as const };
  return { kind: "production" as const };
}

type DeploymentEnvironment = ReturnType<typeof deploymentEnvironment>;

/** `Dash` → `[pr2990] Dash` on a preview, `[dev] Dash` locally, `Dash` in production. */
export function environmentTitle(environment: DeploymentEnvironment, title: string) {
  if (environment.kind === "production") return title;
  return `[${environment.kind === "preview" ? `pr${environment.pr}` : "dev"}] ${title}`;
}

/** Production's icon is the app's own file (`productionHref`), byte for byte; preview and dev get
 *  an inline SVG, so no app ships or routes a second file. */
export function environmentFaviconHref(environment: DeploymentEnvironment, productionHref: string) {
  if (environment.kind === "production") return productionHref;
  return `data:image/svg+xml,${encodeURIComponent(environmentFaviconSvg(environment))}`;
}

/**
 * Preview: purple, the PR number in white as large as the square allows (PR numbers run to four
 * digits and more, too many for the corner badge #2197 drew for single-digit preview slots).
 * Dev: teal, the white iterate mark (apps/os/public/iterate-logo.svg's paths).
 */
export function environmentFaviconSvg(
  environment: Exclude<DeploymentEnvironment, { kind: "production" }>,
) {
  if (environment.kind === "dev")
    return `<svg width="500" height="500" viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg"><rect width="500" height="500" fill="${FAVICON_BACKGROUNDS.dev}"/><g fill="white" transform="translate(20 20) scale(0.92)"><path d="M264.649 170.149H289.821L286.092 186.904L276.303 233.444L270.709 259.971L263.717 293.015L258.124 320.008L251.131 352.586L249.267 364.687V371.668L249.733 372.133H253.462L259.522 369.806L266.048 365.617L275.371 357.24L282.829 349.328L286.558 345.14L288.888 346.071L294.948 350.725L308 360.498L307.068 362.36L303.339 367.944L296.813 376.322L291.685 382.837L286.558 388.422L282.363 393.076L275.837 399.592L272.108 402.849L267.446 406.573L262.785 409.83L256.725 413.554L247.869 417.742L238.08 420.535L231.554 421H224.096L216.637 420.069L211.51 418.673L206.382 416.811L201.255 413.088L196.594 408.434L192.865 400.988L191.466 394.938L191 389.818V383.768L193.797 365.152L199.857 335.832L207.315 301.392L224.096 223.205L225.028 216.224V206.916L224.562 205.054L222.231 204.123L219.434 203.193L206.382 203.658L196.127 204.589H193.331V178.526L194.263 175.734L258.59 170.615L264.649 170.149Z"/><path d="M264.649 78H268.844L275.836 78.9308L282.362 80.7924L287.49 83.5848L292.151 87.7734L295.414 92.8928L297.278 96.616L299.143 105.924L299.609 113.836L299.143 118.49L298.677 122.213L296.812 128.729L293.549 134.779L290.286 138.502L286.091 141.76L282.362 143.621L278.167 145.018L274.438 145.948L267.912 146.414H260.92L254.394 145.483L249.267 144.087L244.139 141.294L239.944 138.037L236.681 133.383L233.884 127.332L232.486 121.282L232.02 117.559V108.716L232.952 101.735L234.816 95.6852L237.613 90.1004L240.41 86.3772L246.936 82.1886L252.529 79.8616L259.522 78.4654L264.649 78Z"/></g></svg>`;
  const digits = String(environment.pr);
  // A bold sans digit is about 0.58em wide: fill 460 of the 500 across, and no taller than 360.
  const fontSize = Math.min(360, Math.floor(460 / (0.58 * digits.length)));
  // Three digits and more are stretched upright (at most 1.6×) to stay legible at 16px.
  const stretch = Math.min(1.6, 360 / fontSize);
  // Centred: the baseline sits half a digit's height (≈ 0.72em) below the middle.
  const baseline = Math.round((250 + 0.36 * fontSize * stretch) / stretch);
  return `<svg width="500" height="500" viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg"><rect width="500" height="500" fill="${FAVICON_BACKGROUNDS.preview}"/><text x="250" y="${baseline}" transform="scale(1 ${Math.round(stretch * 100) / 100})" text-anchor="middle" fill="white" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="800">${digits}</text></svg>`;
}

const FAVICON_BACKGROUNDS = { preview: "#7C3AED", dev: "#0F766E" };
