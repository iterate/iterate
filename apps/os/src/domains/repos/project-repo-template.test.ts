import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { PROJECT_REPO_INITIAL_FILES } from "./project-repo-template.generated.ts";

function templateFile(path: string): string {
  return PROJECT_REPO_INITIAL_FILES.find((file) => file.path === path)!.content;
}

test("template @slack/web-api range matches the apps/os dependency", () => {
  // The host copy is a real runtime dependency (the Slack itx caller wraps a
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
    hostPackageJson.dependencies?.["@slack/web-api"] ||
    hostPackageJson.devDependencies?.["@slack/web-api"];

  expect(templatePackageJson.dependencies["@slack/web-api"]).toBe(hostRange);

  // The Slack surface is configured by an inline constant in worker.ts — the
  // old standalone slack.config.ts is gone.
  expect(PROJECT_REPO_INITIAL_FILES.map((file) => file.path)).not.toContain("slack.config.ts");
  expect(templateFile("worker.ts")).toContain("const slackConfig");
});

test("template gets the platform types from iterate/sdk, not a committed snapshot", () => {
  // Seeded repos used to carry a 2000-line sdk.ts, a copy of the itx contract
  // frozen at seed time. Now the types come from the published `iterate`
  // package — pkg.pr.new's @main URL resolves to the latest build published
  // from main (.github/workflows/pkg-pr-new.yml), so `npm install` in a
  // seeded repo always gets the contract the platform currently speaks. The
  // seeded sdk.ts that remains is only the small runtime companion (the
  // IterateProjectWorker base class) re-exporting the package's types.
  const seededSdk = templateFile("sdk.ts");
  expect(seededSdk).toContain('export type * from "iterate/sdk"');
  expect(seededSdk).toContain("export class IterateProjectWorker");
  expect(seededSdk).not.toContain("codegen:start");

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    dependencies: Record<string, string>;
  };
  // A runtime dependency (not dev): worker.ts imports StreamProcessor and
  // friends from iterate/sdk, so the worker build pipeline installs it.
  expect(templatePackageJson.dependencies).toMatchObject({
    iterate: "https://pkg.pr.new/iterate/iterate/iterate@main",
  });

  expect(templateFile("worker.ts")).toContain('from "./sdk.ts"');
  expect(templateFile("worker.ts")).toContain('from "iterate/sdk"');
});

test("template app links use custom-domain subdomains only for custom host routes", () => {
  const worker = templateFile("worker.ts");

  expect(worker).toContain('req.headers.get("x-iterate-host-kind")');
  expect(worker).toContain(
    'hostKind === "custom" ? `${slug}.${url.host}` : `${slug}--${url.host}`',
  );
});
