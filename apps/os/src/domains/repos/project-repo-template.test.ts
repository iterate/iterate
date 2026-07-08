import { expect, test } from "vitest";
import { PROJECT_REPO_INITIAL_FILES } from "./project-repo-template.generated.ts";

function templateFile(path: string): string {
  return PROJECT_REPO_INITIAL_FILES.find((file) => file.path === path)!.content;
}

test("template gets the platform types from iterate/sdk, not a committed snapshot", () => {
  // Seeded repos used to carry sdk.ts, a copy of the itx contract frozen at
  // seed time. Now the types come from the published `iterate` package —
  // pkg.pr.new's @main URL resolves to the latest build published from main
  // (.github/workflows/pkg-pr-new.yml), so `npm install` in a seeded repo
  // always gets the contract the platform currently speaks.
  expect(PROJECT_REPO_INITIAL_FILES.map((file) => file.path)).not.toContain("sdk.ts");

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    devDependencies: Record<string, string>;
  };
  expect(templatePackageJson.devDependencies).toMatchObject({
    iterate: "https://pkg.pr.new/iterate/iterate/iterate@main",
  });

  expect(templateFile("worker.ts")).toContain('from "iterate/sdk"');
});

test("template app links use custom-domain subdomains only for custom host routes", () => {
  const worker = templateFile("worker.ts");

  expect(worker).toContain('req.headers.get("x-iterate-host-kind")');
  expect(worker).toContain(
    'hostKind === "custom" ? `${slug}.${url.host}` : `${slug}--${url.host}`',
  );
});
