import { describe, expect, test } from "vitest";
import {
  MAX_PREVIEW_NAME_LENGTH,
  previewPullRequestNumber,
  renderPullRequestSection,
  resolvePreviewName,
  slugifyPreviewName,
  splicePullRequestBody,
} from "./preview.ts";

describe("the preview name (cloudflare-os: pr<n>-<branch slug>)", () => {
  test.each([
    ["feature/foo", "123", "pr123-feature-foo"],
    ["Feature_Foo", "123", "pr123-feature-foo"],
    ["feature/foo", "", "feature-foo"],
    ["feature/foo", undefined, "feature-foo"],
    ["--", "7", "pr7-preview"],
  ])("%s with PR %s → %s", (name, prNumber, expected) => {
    expect(resolvePreviewName({ name, prNumber })).toBe(expected);
  });

  test("a long branch is truncated with a stable hash, inside the limit, number first", () => {
    const name = resolvePreviewName({
      name: "jonas/os-next-worker-previews-with-a-very-long-descriptive-branch-name",
      prNumber: "2750",
    });
    expect(name.length).toBeLessThanOrEqual(MAX_PREVIEW_NAME_LENGTH);
    expect(name).toMatch(/^pr2750-[a-z0-9-]+-[0-9a-f]{6}$/);
    expect(name).toBe(
      resolvePreviewName({
        name: "jonas/os-next-worker-previews-with-a-very-long-descriptive-branch-name",
        prNumber: "2750",
      }),
    );
    expect(slugifyPreviewName("a".repeat(40))).not.toBe(slugifyPreviewName("a".repeat(41)));
  });

  test("the number reads back out of the name; a bare slug has none", () => {
    expect(previewPullRequestNumber("pr123-feature-foo")).toBe(123);
    expect(previewPullRequestNumber("feature-foo")).toBeUndefined();
    expect(previewPullRequestNumber("pr-foo")).toBeUndefined();
  });
});

describe("the PR body's managed section", () => {
  const section = renderPullRequestSection({
    previewName: "pr123-feature-foo",
    url: "https://pr123-feature-foo-os-next-preview-2.iterate-dev-preview.workers.dev",
    deploymentId: "bd68a9bb-b323-47fd-bc6b-c4cae7b29c8c",
    dashboardUrl: "https://dash.cloudflare.com/x",
    prNumber: "123",
    branch: "feature/foo",
  });

  test("names the URL, the deployment and every operation, collapsed", () => {
    expect(section).toContain(
      "https://pr123-feature-foo-os-next-preview-2.iterate-dev-preview.workers.dev",
    );
    expect(section).toContain("deployment `bd68a9bb`");
    expect(section).toContain("<details>");
    for (const action of ["reset", "e2e", "deploy", "delete"]) {
      expect(section).toContain(`--input pull-request-number=123 --input action=${action}`);
      expect(section).toContain(`pnpm preview ${action} --pr 123 --name feature/foo`);
    }
  });

  test("appends to a body without one, keeping the author's text", () => {
    const body = splicePullRequestBody("What this PR does.\n", section);
    expect(body.startsWith("What this PR does.\n\n<!-- os-next-preview:begin -->\n")).toBe(true);
    expect(body.endsWith("\n<!-- os-next-preview:end -->\n")).toBe(true);
  });

  test("replaces an existing section in place, and only that", () => {
    const before = `Intro.\n\n<!-- os-next-preview:begin -->\nold\n<!-- os-next-preview:end -->\n\nOutro.\n`;
    const after = splicePullRequestBody(before, "new");
    expect(after).toBe(
      `Intro.\n\n<!-- os-next-preview:begin -->\nnew\n<!-- os-next-preview:end -->\n\nOutro.\n`,
    );
    expect(splicePullRequestBody(after, "newer")).not.toContain("new\n<!--");
  });

  test("an empty body becomes just the section", () => {
    expect(splicePullRequestBody("", "s")).toBe(
      "<!-- os-next-preview:begin -->\ns\n<!-- os-next-preview:end -->\n",
    );
  });
});
