import { expect, test } from "vitest";
import {
  deploymentEnvironment,
  environmentFaviconHref,
  environmentFaviconSvg,
  environmentTitle,
} from "./environment-favicon.ts";

test.each([
  "os.iterate.com",
  "dash.iterate.com",
  "voice.iterate.com",
  "k.iterate.com",
  "agents.iterate.workers.dev",
  "notes.iterate.workers.dev",
  // the parents of the per-PR previews, and an experiment: not a PR
  "os-next-preview.iterate-dev-preview.workers.dev",
  "exp-jonas-os-next-preview.iterate-dev-preview.workers.dev",
  // `pr` must lead the hostname, and the host must be workers.dev
  "notpr12-x-os-preview.iterate-dev-preview.workers.dev",
  "pr12-x.iterate.com",
])("%s is production", (hostname) => {
  expect(deploymentEnvironment(hostname)).toEqual({ kind: "production" });
});

test.each([
  ["pr2990-environment-favicons-os-next-preview.iterate-dev-preview.workers.dev", 2990],
  ["pr2990-environment-favicons-dash-preview.iterate-dev-preview.workers.dev", 2990],
  ["pr7-x-os-preview.iterate-dev-preview.workers.dev", 7],
])("%s is PR %i's preview", (hostname, pr) => {
  expect(deploymentEnvironment(hostname)).toEqual({ kind: "preview", pr });
});

test.each(["localhost", "petshop.localhost", "127.0.0.1"])("%s is dev", (hostname) => {
  expect(deploymentEnvironment(hostname)).toEqual({ kind: "dev" });
});

test("the title is prefixed off production only", () => {
  expect(environmentTitle({ kind: "production" }, "Dash")).toBe("Dash");
  expect(environmentTitle({ kind: "preview", pr: 2990 }, "Dash")).toBe("[pr2990] Dash");
  expect(environmentTitle({ kind: "dev" }, "Sign in · Dash")).toBe("[dev] Sign in · Dash");
});

test("production keeps its own icon file", () => {
  expect(environmentFaviconHref({ kind: "production" }, "/iterate-logo.svg")).toBe(
    "/iterate-logo.svg",
  );
});

test("a preview's icon is purple, with its PR number", () => {
  const svg = decodeSvg(environmentFaviconHref({ kind: "preview", pr: 2990 }, "/x.svg"));
  expect(svg).toContain('fill="#7C3AED"');
  expect(svg).toContain(">2990</text>");
});

test("dev's icon is teal, with the iterate mark", () => {
  const svg = decodeSvg(environmentFaviconHref({ kind: "dev" }, "/x.svg"));
  expect(svg).toContain('fill="#0F766E"');
  expect(svg).toContain("<path");
  expect(svg).not.toContain("<text");
});

test.each([
  [7, 360],
  [42, 360],
  [123, 264],
  [2990, 198],
  [12345, 158],
])("PR %i's digits fit across the square at font-size %i", (pr, fontSize) => {
  expect(environmentFaviconSvg({ kind: "preview", pr })).toContain(`font-size="${fontSize}"`);
});

function decodeSvg(href: string) {
  const prefix = "data:image/svg+xml,";
  expect(href.startsWith(prefix)).toBe(true);
  return decodeURIComponent(href.slice(prefix.length));
}
