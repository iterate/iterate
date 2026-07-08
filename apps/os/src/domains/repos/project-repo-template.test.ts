import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { PROJECT_REPO_INITIAL_FILES } from "./project-repo-template.generated.ts";

function templateFile(path: string): string {
  return PROJECT_REPO_INITIAL_FILES.find((file) => file.path === path)!.content;
}

test("template @slack/web-api range matches the apps/os dependency", () => {
  // The host copy is a real runtime dependency now (the Slack itx caller wraps a
  // WebClient — slack-api.ts); the version that RUNS inside a project worker is
  // installed by the worker build pipeline from the template's own package.json.
  // Keeping the two ranges equal keeps host + project runtime on the same SDK.
  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    dependencies: Record<string, string>;
  };
  const hostPackageJson = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const hostRange =
    hostPackageJson.dependencies?.["@slack/web-api"] ??
    hostPackageJson.devDependencies?.["@slack/web-api"];

  expect(templatePackageJson.dependencies["@slack/web-api"]).toBe(hostRange);
});

test("template sdk.ts carries the current platform itx contract verbatim", () => {
  // sdk.ts declares a `codegen: copy` marker over ../src/itx-api.generated.ts,
  // but that preset has silently not fired under the oxlint js-plugin bridge —
  // the snapshot drifted for weeks without a lint error. This test is the
  // deterministic guard: seeded projects must get the types the platform
  // actually speaks (ItxBinding, worker refs, …). On failure, run
  // `pnpm lint --fix` to re-copy the generated contract between sdk.ts's
  // codegen markers.
  const sdk = templateFile("sdk.ts");
  const types = readFileSync(new URL("../../../src/itx-api.generated.ts", import.meta.url), "utf8");
  expect(sdk).toContain(types.trimEnd());
});

test("template app links use custom-domain subdomains only for custom host routes", () => {
  const worker = templateFile("worker.ts");

  expect(worker).toContain('req.headers.get("x-iterate-host-kind")');
  expect(worker).toContain(
    'hostKind === "custom" ? `${slug}.${url.host}` : `${slug}--${url.host}`',
  );
});
