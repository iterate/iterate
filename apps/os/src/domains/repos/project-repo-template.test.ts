import { expect, test } from "vitest";
import { PROJECT_REPO_INITIAL_FILES } from "./project-repo-template.generated.ts";

function templateFile(path: string): string {
  return PROJECT_REPO_INITIAL_FILES.find((file) => file.path === path)!.content;
}

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
    devDependencies: Record<string, string>;
  };
  expect(templatePackageJson.devDependencies).toMatchObject({
    iterate: "https://pkg.pr.new/iterate/iterate/iterate@main",
  });

  expect(templateFile("worker.ts")).toContain('from "./sdk.ts"');
});

test("template app links use custom-domain subdomains only for custom host routes", () => {
  const worker = templateFile("worker.ts");

  expect(worker).toContain('req.headers.get("x-iterate-host-kind")');
  expect(worker).toContain(
    'hostKind === "custom" ? `${slug}.${url.host}` : `${slug}--${url.host}`',
  );
});
