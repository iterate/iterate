export const FAVICON_BACKGROUNDS = {
  preview: "#7C3AED",
  dev: "#0F766E",
} as const;

type EnvironmentFaviconInput = {
  environmentName?: string;
  workerName?: string;
  productionHref: string;
};

/**
 * Production deliberately returns the existing logo asset byte-for-byte.
 * Preview and dev keep the white Iterate mark, with a small environment badge
 * in the free lower-right corner so crowded browser tabs remain distinguishable.
 */
export function environmentFaviconHref(input: EnvironmentFaviconInput) {
  const variant = classifyEnvironment(input);
  if (variant.kind === "production") return input.productionHref;

  const svg = environmentFaviconSvg({
    background: FAVICON_BACKGROUNDS[variant.kind],
    marker: variant.marker,
  });
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function environmentFaviconSvg(input: { background: string; marker: string }) {
  const fontSize = input.marker.length > 1 ? 112 : 150;

  return `<svg width="500" height="500" viewBox="0 0 500 500" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="500" height="500" fill="${input.background}"/>
<path d="M264.649 170.149H289.821L286.092 186.904L276.303 233.444L270.709 259.971L263.717 293.015L258.124 320.008L251.131 352.586L249.267 364.687V371.668L249.733 372.133H253.462L259.522 369.806L266.048 365.617L275.371 357.24L282.829 349.328L286.558 345.14L288.888 346.071L294.948 350.725L308 360.498L307.068 362.36L303.339 367.944L296.813 376.322L291.685 382.837L286.558 388.422L282.363 393.076L275.837 399.592L272.108 402.849L267.446 406.573L262.785 409.83L256.725 413.554L247.869 417.742L238.08 420.535L231.554 421H224.096L216.637 420.069L211.51 418.673L206.382 416.811L201.255 413.088L196.594 408.434L192.865 400.988L191.466 394.938L191 389.818V383.768L193.797 365.152L199.857 335.832L207.315 301.392L224.096 223.205L225.028 216.224V206.916L224.562 205.054L222.231 204.123L219.434 203.193L206.382 203.658L196.127 204.589H193.331V178.526L194.263 175.734L258.59 170.615L264.649 170.149Z" fill="white"/>
<path d="M264.649 78H268.844L275.836 78.9308L282.362 80.7924L287.49 83.5848L292.151 87.7734L295.414 92.8928L297.278 96.616L299.143 105.924L299.609 113.836L299.143 118.49L298.677 122.213L296.812 128.729L293.549 134.779L290.286 138.502L286.091 141.76L282.362 143.621L278.167 145.018L274.438 145.948L267.912 146.414H260.92L254.394 145.483L249.267 144.087L244.139 141.294L239.944 138.037L236.681 133.383L233.884 127.332L232.486 121.282L232.02 117.559V108.716L232.952 101.735L234.816 95.6852L237.613 90.1004L240.41 86.3772L246.936 82.1886L252.529 79.8616L259.522 78.4654L264.649 78Z" fill="white"/>
<circle cx="395" cy="395" r="96" fill="white" stroke="${input.background}" stroke-width="12"/>
<text x="395" y="445" text-anchor="middle" fill="${input.background}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="800">${input.marker}</text>
</svg>`;
}

function classifyEnvironment(
  input: Pick<EnvironmentFaviconInput, "environmentName" | "workerName">,
) {
  const workerName = input.workerName?.trim().toLowerCase();
  if (workerName === "os-prd") return { kind: "production" as const };

  const workerPreview = /^os-preview-(\d+)$/.exec(workerName ?? "");
  if (workerPreview) {
    return { kind: "preview" as const, marker: normalizeSlot(workerPreview[1]) };
  }

  const environmentName = input.environmentName?.trim().toLowerCase();
  if (environmentName === "prd") return { kind: "production" as const };

  const environmentPreview = /^preview_(\d+)$/.exec(environmentName ?? "");
  if (environmentPreview) {
    return { kind: "preview" as const, marker: normalizeSlot(environmentPreview[1]) };
  }

  const dev = /^dev(?:_(.+))?$/.exec(environmentName ?? "");
  if (dev || workerName === "os") {
    const marker = dev?.[1]?.match(/[a-z0-9]/i)?.[0]?.toUpperCase() ?? "D";
    return { kind: "dev" as const, marker };
  }

  // Keep the existing favicon when older or nonstandard deployments do not
  // expose an identity. A decorative cue must never break document metadata.
  return { kind: "production" as const };
}

function normalizeSlot(slot: string) {
  return String(Number.parseInt(slot, 10));
}
