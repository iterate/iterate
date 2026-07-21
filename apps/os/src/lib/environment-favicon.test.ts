import { describe, expect, it } from "vitest";
import {
  FAVICON_BACKGROUNDS,
  environmentFaviconHref,
  environmentFaviconSvg,
} from "./environment-favicon.ts";

const productionHref = "/assets/iterate-logo.svg";

describe("environmentFaviconHref", () => {
  it("keeps the production favicon unchanged", () => {
    expect(
      environmentFaviconHref({
        environmentName: "prd",
        workerName: "os-prd",
        productionHref,
      }),
    ).toBe(productionHref);
  });

  it("uses the preview slot from the authoritative worker name", () => {
    const svg = decodeSvg(
      environmentFaviconHref({
        environmentName: "dev_jonas",
        workerName: "os-preview-7",
        productionHref,
      }),
    );

    expect(svg).toContain(`fill="${FAVICON_BACKGROUNDS.preview}"`);
    expect(svg).toContain(">7</text>");
  });

  it.each([
    ["dev_jonas", "J"],
    ["dev_misha", "M"],
    ["dev", "D"],
  ])("marks %s with %s", (environmentName, marker) => {
    const svg = decodeSvg(
      environmentFaviconHref({ environmentName, workerName: "os", productionHref }),
    );

    expect(svg).toContain(`fill="${FAVICON_BACKGROUNDS.dev}"`);
    expect(svg).toContain(`>${marker}</text>`);
  });

  it("falls back to the current favicon for an unknown environment", () => {
    expect(environmentFaviconHref({ productionHref })).toBe(productionHref);
  });
});

describe("environmentFaviconSvg", () => {
  it("shrinks a multi-digit preview marker to fit its badge", () => {
    const svg = environmentFaviconSvg({ background: FAVICON_BACKGROUNDS.preview, marker: "12" });

    expect(svg).toContain('font-size="112"');
    expect(svg).toContain(">12</text>");
  });
});

function decodeSvg(href: string) {
  const [, encodedSvg] = href.split(",", 2);
  if (!encodedSvg) throw new Error(`Expected an SVG data URL, received ${href}`);
  return decodeURIComponent(encodedSvg);
}
