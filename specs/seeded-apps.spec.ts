import { expect } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import { E2E_HEAVY_TEST_TIMEOUT_MS } from "@iterate-com/shared/test-support/e2e-policy";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import {
  signUpWithEmailOtp,
  startEmailOtpSignIn,
  uniqueSignupEmail,
} from "./test-support/email-otp-signup.ts";
import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

// The seeded config repo's example apps genuinely serve after a project is
// created: the guestbook (stream-processor reduce on /guestbook, Cap'n Web
// live state) takes a signature and pushes it live — through real project
// ingress, in a real browser.
test("the seeded guestbook app works after creating a project", async ({
  baseURL,
  helpers,
  page,
}) => {
  test.setTimeout(E2E_HEAVY_TEST_TIMEOUT_MS);
  await using fixture = await helpers.createFixture("seeded-apps");

  // Guestbook: worker-bundler installs the deployment-pinned Iterate package
  // plus its shared Cap'n Web alias and compiles client.tsx into the browser
  // module. Seeing the signed note proves that the SDK's LiveState target and
  // the app's RPC root share one Cap'n Web class identity end to end.
  await page.goto(appUrl("guestbook", fixture.project.slug, baseURL!));
  await page.getByRole("heading", { name: "Guestbook" }).waitFor({ timeout: 120_000 });

  const note = `note-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel("Name").fill("Ada");
  await page.getByLabel("Message").fill(note);
  await page.getByRole("button", { name: "Sign guestbook" }).click();
  await page.getByText(note).waitFor({ timeout: 30_000 });

  await page.reload();
  await page.getByText(note).waitFor({ timeout: 30_000 });
});

// Unlike the public guestbook above, this proof uses a real Auth-backed user
// and organization: project-member auth deliberately checks the live Auth
// directory on every request, not merely the OS access-token claims used by
// the suite's usual forged-session fixture.
test("the seeded todo app authenticates a real project member", async ({
  baseURL,
  page,
}, testInfo) => {
  test.setTimeout(E2E_HEAVY_TEST_TIMEOUT_MS);
  test.skip(
    !(await startEmailOtpSignIn(page, testInfo)),
    "Email OTP sign-in is disabled for this deployment (APP_CONFIG_EMAIL_OTP_ENABLED on auth / APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED on OS).",
  );

  const slug = uniqueFixtureSlug("todo-app-auth");
  await signUpWithEmailOtp(page, {
    email: uniqueSignupEmail("todo-app-auth"),
    projectSlug: slug,
    testInfo,
  });

  // First-run onboarding creates the Auth directory membership and the
  // project together. Its destination renders an unmarked skeleton, so wait
  // for the project route with spinner-waiter disabled, as signup.spec.ts does.
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page.getByPlaceholder("Message this agent").waitFor({ timeout: 60_000 });
  });

  // The project-app origin has no session yet, even though this browser is
  // already signed in to OS. The auth partial owns the request and renders
  // the form on the app's own origin, under its strict CSP; the platform's
  // worker-status overlay must ride that CSP via its nonce, not inline
  // script.
  const todoUrl = appUrl("todo", slug, baseURL!);
  const signInResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === todoUrl &&
      response.request().resourceType() === "document" &&
      response.headers()["content-security-policy"]?.includes("default-src 'none'") === true,
    { timeout: 120_000 },
  );
  await page.goto(todoUrl);
  // The app's first use may still need its own cold worker start. The
  // platform's building page is visible progress; 120s mirrors the ingress
  // e2e's cold-build budget.
  await page.getByRole("heading", { name: "Sign in to iterate" }).waitFor({ timeout: 120_000 });
  await page.getByText("This app is available to project members.").waitFor();
  const signInResponse = await signInResponsePromise;
  const overlay = page.locator("iterate-worker-status[data-iterate-worker-overlay]");
  await overlay.waitFor({ state: "visible" });
  expect(await overlay.locator("script").count()).toBe(0);
  const overlayNonce = await overlay
    .locator("style")
    .evaluate((style: HTMLStyleElement) => style.nonce);
  expect(overlayNonce).not.toBe("");
  expect(signInResponse.headers()["content-security-policy"]).toContain(`'nonce-${overlayNonce}'`);

  // This follows app -> OS -> app callback. OS reuses the iterate_session
  // cookie installed by the signup flow; the callback redeems a fragment token
  // into an app-host-only HttpOnly cookie before returning to `/`. The click
  // waits through two origins and three navigations, then worker-bundler
  // transforms the package-backed server and compiles the browser entry —
  // preserve the real cold-build deadline instead of letting spinner-waiter
  // collapse the wait to its no-spinner fast-fail.
  await page.getByRole("link", { name: "Continue with iterate" }).click({ timeout: 30_000 });

  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page.getByRole("heading", { name: "Todo" }).waitFor({ timeout: 120_000 });
  });

  const todoTitle = `todo-${crypto.randomUUID().slice(0, 8)}`;
  const composer = page.getByLabel("New todo");
  await composer.fill(todoTitle);
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByText(todoTitle).waitFor();

  await page.getByLabel(`Mark ${todoTitle} done`).click();
  await page.getByLabel(`Mark ${todoTitle} not done`).waitFor();

  // Durability: the row and its completed state live in the app's Durable
  // Object state, so a fresh page load reads them back.
  await page.reload();
  await page.getByText(todoTitle).waitFor({ timeout: 30_000 });
  await page.getByRole("checkbox", { checked: true, name: `Mark ${todoTitle} not done` }).waitFor();
});

test("review a workspace document in the seeded Docs app", async ({ baseURL, page }, testInfo) => {
  test.setTimeout(E2E_HEAVY_TEST_TIMEOUT_MS);
  test.skip(
    !(await startEmailOtpSignIn(page, testInfo)),
    "Email OTP sign-in is disabled for this deployment (APP_CONFIG_EMAIL_OTP_ENABLED on auth / APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED on OS).",
  );

  const slug = uniqueFixtureSlug("docs-app-review");
  await signUpWithEmailOtp(page, {
    email: uniqueSignupEmail("docs-app-review"),
    projectSlug: slug,
    testInfo,
  });
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page.getByPlaceholder("Message this agent").waitFor({ timeout: 60_000 });
  });

  const workspacePath = "/workspaces/agents/reviewer";
  // Relative on purpose, twice over: workspace writes resolve relative paths
  // against the workspace's own directory (the only writable home for private
  // files — absolute paths outside it and the /repos/** mounts are rejected),
  // and the Docs app resolves a relative `path` param against the `workspace`
  // param the same way.
  const documentPath = "reviews/launch-review.md";
  using itx = await connectAdminItx(baseURL!);
  using project = itx.projects.get(slug);
  using workspace = project.workspaces.get(workspacePath);
  await workspace.create({});
  await workspace.writeFile(
    documentPath,
    [
      "---",
      "status: draft",
      "owner: Product",
      "---",
      "",
      "# Docs review walkthrough",
      "",
      "Review a document directly in its agent workspace.",
      "",
      "## Ready for review",
      "",
      "- [x] Workspace deep links",
      "- [ ] Review the launch copy",
      "- [ ] Confirm the rollout owner",
      "",
      "## Review focus",
      "",
      "Make review decisions directly in the workspace file.",
      "",
    ].join("\n"),
  );
  await project.kv.set("docs-app-origin", docsOriginForBaseUrl(baseURL!));

  const docsUrl = new URL(appUrl("docs", slug, baseURL!));
  docsUrl.searchParams.set("workspace", workspacePath);
  docsUrl.searchParams.set("path", documentPath);
  await page.goto(docsUrl.toString());
  await page.getByRole("heading", { name: "Sign in to iterate" }).waitFor({ timeout: 120_000 });
  await page.getByText("This app is available to project members.").waitFor();
  await page.getByRole("link", { name: "Continue with iterate" }).click({ timeout: 30_000 });

  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    // The header names the document by its workspace-relative path (the
    // sidebar owns the workspace name; the document's own H1 carries the
    // title). The live status is visually silent but stays in the
    // accessibility tree — still the signal that the editor synced.
    await page
      .locator("header")
      .getByRole("heading", { name: documentPath })
      .waitFor({ timeout: 120_000 });
  });
  await page.getByText(/^live · v\d+$/).waitFor({ timeout: 30_000 });
  // The PR walkthrough is about reviewing the document, not account
  // provisioning and cold-start setup that this end-to-end proof also covers.
  page.videoMode?.setStartTime();

  // A task-list checkbox is part of its list row, not a detached line above
  // the copy. This geometric assertion protects the exact rendering failure
  // that made the first Docs screenshots hard to scan.
  const checklistItem = page.locator("li[data-task]").filter({ hasText: "Review the launch copy" });
  const checkboxBox = await checklistItem.locator('input[type="checkbox"]').boundingBox();
  const labelBox = await checklistItem
    .getByText("Review the launch copy", { exact: true })
    .boundingBox();
  expect(checkboxBox).not.toBeNull();
  expect(labelBox).not.toBeNull();
  expect(
    Math.abs(checkboxBox!.y + checkboxBox!.height / 2 - (labelBox!.y + labelBox!.height / 2)),
  ).toBeLessThan(5);

  await page.getByRole("button", { name: "Source" }).click();
  const editor = page.locator(".cm-content");
  await editor.waitFor();
  await editor.click();
  // Select-all + ArrowRight parks the cursor at the end on macOS and Linux;
  // Cmd/Ctrl+End is not a consistent CodeMirror binding across both.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("\n\nReviewed in Docs.");
  await editor.getByText("Reviewed in Docs.", { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Preview" }).click();
  await page
    .locator("div.cursor-text")
    .getByText("Reviewed in Docs.", { exact: true })
    .waitFor({ timeout: 10_000 });

  await page.getByRole("button", { name: "Comment on document" }).click();
  await page
    .getByPlaceholder("Comment on the entire document…")
    .fill("Please add a short owner summary before sharing.");
  await page.getByRole("button", { name: "Add document comment" }).click();
  const commentsPanel = page.getByRole("complementary");
  await commentsPanel
    .getByText("Please add a short owner summary before sharing.", { exact: true })
    .waitFor();
  await commentsPanel.getByText("Whole document", { exact: true }).waitFor();

  const reviewSentence = page
    .locator("div.cursor-text")
    .getByText("Make review decisions directly in the workspace file.", { exact: true });
  await reviewSentence.selectText();
  await reviewSentence.dispatchEvent("mouseup");
  const selectionCommentButton = page.getByRole("button", { name: "Comment", exact: true });
  await selectionCommentButton.waitFor({ timeout: 10_000 });
  await selectionCommentButton.click();
  await page
    .getByPlaceholder("Comment on the selection…")
    .fill("Can we make this promise more concrete?");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await commentsPanel
    .getByText("Can we make this promise more concrete?", { exact: true })
    .waitFor();
  await commentsPanel.getByText("Selected text", { exact: true }).waitFor();
});

/**
 * App hosts are `<app>--<project>.<base>`, one origin per app. Locally the
 * base is the dev server's `.localhost` port (Chromium resolves `*.localhost`
 * to loopback natively — no Host-header tricks needed, unlike Node fetch);
 * deployed runs read the wildcard base from APP_CONFIG_PROJECT_HOSTNAME_BASES
 * with the same preview-hostname fallback as the ingress e2e.
 */
function appUrl(appSlug: string, projectSlug: string, baseURL: string) {
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

function docsOriginForBaseUrl(baseURL: string): string {
  const override = process.env.DOCS_APP_ORIGIN?.trim();
  if (override) return override.replace(/\/+$/, "");
  const previewMatch = /^os\.iterate-preview-(\d+)\.com$/.exec(new URL(baseURL).hostname);
  if (previewMatch) {
    return `https://docs-preview-${previewMatch[1]}.iterate-dev-preview.workers.dev`;
  }
  if (new URL(baseURL).hostname === "os.iterate.com") return "https://docs.iterate.workers.dev";
  throw new Error("DOCS_APP_ORIGIN is required when running the Docs app spec outside preview.");
}
