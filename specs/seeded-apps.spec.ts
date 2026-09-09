import { expect } from "@playwright/test";
import { readReview } from "iterate/document-review";
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
  // The platform's building page is real spinner UI (data-spinner on the
  // status widget), so raise the spinner-waiter's ceiling to the cold-build
  // budget instead of hand-rolling a timeout.
  await spinnerWaiter.settings.run({ spinnerTimeout: 130_000 }, async () => {
    await page.getByRole("heading", { name: "Guestbook" }).waitFor();
  });

  const note = `note-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel("Name").fill("Ada");
  await page.getByLabel("Message").fill(note);
  await page.getByRole("button", { name: "Sign guestbook" }).click();
  await page.getByText(note).waitFor({ timeout: 30_000 }); // timeout: manual budget — the seeded guestbook renders no spinner-waiter-visible loading UI

  await page.reload();
  await page.getByText(note).waitFor({ timeout: 30_000 }); // timeout: manual budget — reload repaints with no spinner-waiter-visible loading UI
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
    await page.getByPlaceholder("Message this agent").waitFor({ timeout: 60_000 }); // timeout: manual — spinner-waiter is disabled for this unmarked skeleton
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
    { timeout: 120_000 }, // timeout: response-event wait, invisible to the spinner-waiter — same cold-build budget as the heading below
  );
  await page.goto(todoUrl);
  // The app's first use may still need its own cold worker start. The
  // platform's building page is visible progress — real spinner UI — so the
  // spinner-waiter rides it with its ceiling raised to the cold-build budget.
  await spinnerWaiter.settings.run({ spinnerTimeout: 130_000 }, async () => {
    await page.getByRole("heading", { name: "Sign in to iterate" }).waitFor();
  });
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
  await page.getByRole("link", { name: "Continue with iterate" }).click({ timeout: 30_000 }); // timeout: the real cross-origin cold-build deadline the note above describes — spinner-waiter would fast-fail it

  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page.getByRole("heading", { name: "Todo" }).waitFor({ timeout: 120_000 }); // timeout: manual cold-build budget — spinner-waiter is disabled for this wait
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
  await page.getByText(todoTitle).waitFor({ timeout: 30_000 }); // timeout: manual budget — reload repaints with no spinner-waiter-visible loading UI
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
  // Review needs the authenticated project, independently of the chat composer.
  await page.getByRole("link", { name: "New agent", exact: true }).waitFor();

  const workspacePath = "/agents/reviewer";
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
      "| Area | Decision |",
      "| --- | --- |",
      "| Launch copy | Draft |",
      "| Rollout | Pending |",
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
  // Every WebSocket the page opens is kept in reach so the test can cut the
  // live session under the editor later and watch it come back.
  await page.addInitScript(() => {
    const sockets: WebSocket[] = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        sockets.push(this);
      }
    } as typeof WebSocket;
    (window as unknown as { __sockets: WebSocket[] }).__sockets = sockets;
  });
  await page.goto(docsUrl.toString());
  // Same cold-build lane as the todo app above: the building page's spinner
  // carries the wait, ceiling raised to match.
  await spinnerWaiter.settings.run({ spinnerTimeout: 130_000 }, async () => {
    await page.getByRole("heading", { name: "Sign in to iterate" }).waitFor();
  });
  await page.getByText("This app is available to project members.").waitFor();
  await page.getByRole("link", { name: "Continue with iterate" }).click({ timeout: 30_000 }); // timeout: cross-origin auth callback + cold build — spinner-waiter would fast-fail it

  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    // The header names the document by its workspace-relative path (the
    // sidebar owns the workspace name; the document's own H1 carries the
    // title). The live status is visually silent but stays in the
    // accessibility tree — still the signal that the editor synced.
    await page
      .locator("header")
      .getByRole("heading", { name: documentPath })
      .waitFor({ timeout: 120_000 }); // timeout: manual cold-build budget — spinner-waiter is disabled for this wait
  });
  await page.getByText(/^live · v\d+$/).waitFor({ timeout: 30_000 }); // timeout: collab attach — the live badge is a11y-only, nothing for the spinner-waiter to watch
  // The PR walkthrough is about reviewing the document, not account
  // provisioning and cold-start setup that this end-to-end proof also covers.
  page.videoMode?.setStartTime();

  // Docs uses one shared browser context here, so these are two real
  // concurrent clients for the same signed-in project member. A second
  // identity would require project-member provisioning that is orthogonal to
  // the editor protocol; distinct live sessions still exercise rebase,
  // presence and every server ordering path.
  const peer = await page.context().newPage();
  await peer.goto(docsUrl.toString());
  await peer.getByText(/^live · v\d+$/).waitFor({ timeout: 30_000 }); // timeout: second app-host load and collab attach have no spinnerWaiter-visible progress

  const editor = page.locator(".cm-content");
  const peerEditor = peer.locator(".cm-content");
  await editor.waitFor();
  await peerEditor.waitFor();

  // A task-list checkbox remains aligned with its item in the live rich
  // CodeMirror view — the raw source text is not a separate preview anymore.
  const checklistItem = page
    .locator(".cm-content")
    .getByText("Review the launch copy", { exact: true });
  const checkboxBox = await checklistItem.locator("xpath=preceding::input[1]").boundingBox();
  const labelBox = await checklistItem.boundingBox();
  expect(checkboxBox).not.toBeNull();
  expect(labelBox).not.toBeNull();
  expect(
    Math.abs(checkboxBox!.y + checkboxBox!.height / 2 - (labelBox!.y + labelBox!.height / 2)),
  ).toBeLessThan(5);

  // Source and rich editing are two presentations of the same CodeMirror
  // state. Toggling cannot serialize or reseed the Markdown buffer.
  const beforePresentationToggle = await workspace.readFile(documentPath);
  await page.getByRole("button", { name: "Source" }).click();
  await page.getByRole("button", { name: "Rich editing" }).click();
  await page.getByText("Docs review walkthrough", { exact: true }).waitFor();
  expect(await workspace.readFile(documentPath)).toBe(beforePresentationToggle);

  // Two independent rich editors concurrently change a body passage and two
  // native table cells. The cells stay ordinary CodeMirror source ranges, so
  // neither participant replaces a whole table widget.
  await Promise.all([
    (async () => {
      await replaceCellWord(page, "Draft", "Approved");
    })(),
    (async () => {
      await replaceCellWord(peer, "Pending", "Scheduled");
    })(),
  ]);
  // Peer carets are children of the native table cell, so exact text locators
  // include their a11y label. Scope to the rendered cells instead.
  await peer
    .locator(".cm-markdown-table-cell")
    .filter({ hasText: "Approved" })
    .waitFor({ timeout: 10_000 }); // timeout: remote CodeMirror update is optimistic UI with no spinnerWaiter-visible progress
  await page
    .locator(".cm-markdown-table-cell")
    .filter({ hasText: "Scheduled" })
    .waitFor({ timeout: 10_000 }); // timeout: remote CodeMirror update is optimistic UI with no spinnerWaiter-visible progress
  await expect
    .poll(() => workspace.readFile(documentPath), {
      timeout: 30_000, // timeout: source durability follows the live push, not spinnerWaiter-visible UI
    })
    .toContain("| Launch copy | Approved |");
  await expect
    .poll(() => workspace.readFile(documentPath), {
      timeout: 30_000, // timeout: source durability follows the live push, not spinnerWaiter-visible UI
    })
    .toContain("| Rollout | Scheduled |");
  await Promise.all([
    appendAtEnd(page, "\n\nPRIMARY_CONCURRENT_BODY"),
    appendAtEnd(peer, "\n\nPEER_CONCURRENT_BODY"),
  ]);
  // A peer-caret label is rendered beside remote text, so use the content
  // projection for the visual assertion and verify both exact markers in the
  // plain-text file below.
  await editor.getByText("PEER_CONCURRENT_BODY").waitFor({ timeout: 10_000 }); // timeout: remote CodeMirror update has no spinnerWaiter-visible progress
  await peerEditor.getByText("PRIMARY_CONCURRENT_BODY").waitFor({ timeout: 10_000 }); // timeout: remote CodeMirror update has no spinnerWaiter-visible progress
  await expect
    .poll(() => workspace.readFile(documentPath), {
      timeout: 30_000, // timeout: source durability follows the live push, not spinnerWaiter-visible UI
    })
    .toContain("PRIMARY_CONCURRENT_BODY");
  await expect
    .poll(() => workspace.readFile(documentPath), {
      timeout: 30_000, // timeout: source durability follows the live push, not spinnerWaiter-visible UI
    })
    .toContain("PEER_CONCURRENT_BODY");

  // The primary user keeps a native selection while the peer inserts text.
  // Comment submission reads the mapped bookmark from the editor's live doc,
  // not the React mirror that deliberately trails typing.
  const reviewSentence = page
    .locator(".cm-content")
    .getByText("Make review decisions directly in the workspace file.", { exact: true });
  await reviewSentence.click({ clickCount: 3 });
  await peerEditor.click();
  await peer.keyboard.press("ControlOrMeta+a");
  await peer.keyboard.press("ArrowLeft");
  await peer.keyboard.insertText("Peer inserted before the selected passage.\n\n");
  await editor.getByText("Peer inserted before the selected passage.").waitFor({ timeout: 10_000 }); // timeout: remote CodeMirror update has no spinnerWaiter-visible progress
  await page.getByRole("button", { name: "Comment on selected text" }).click();
  await page
    .getByPlaceholder("Comment on selected text…")
    .fill("Can we make this promise more concrete?");
  await page.getByRole("button", { name: "Add comment" }).click();
  // The comment footer changes the canonical source length. Wait until the
  // peer has the same RFM before it contributes its later independent edit.
  await peer
    .getByRole("complementary")
    .getByText("Can we make this promise more concrete?", { exact: true })
    .waitFor({ timeout: 10_000 }); // timeout: peer RFM parse follows a remote collab push, not spinnerWaiter-visible UI

  // Undo only removes the local operation. A remote insertion that arrived
  // between local typing and undo remains in both buffers and durable source.
  await appendAtEnd(page, "\n\nLOCAL_UNDONE");
  await appendAtEnd(peer, "\n\nREMOTE_KEPT");
  await editor.getByText("REMOTE_KEPT").waitFor({ timeout: 10_000 }); // timeout: remote CodeMirror update has no spinnerWaiter-visible progress
  await editor.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(async () => String(await workspace.readFile(documentPath)), {
      timeout: 30_000, // timeout: durability arrives through the live collab push, not spinnerWaiter-visible UI
    })
    .toContain("REMOTE_KEPT");
  const afterUndo = (await workspace.readFile(documentPath))!;
  expect(afterUndo).not.toContain("LOCAL_UNDONE");
  expect(readReview(afterUndo)).toMatchObject({ diagnostics: [] });

  // Rich end-of-document insertion belongs before the hidden endmatter.
  await appendAtEnd(page, "\n\nReviewed in Docs.");
  await editor.getByText("Reviewed in Docs.").waitFor({ timeout: 10_000 }); // timeout: tight manual budget — rich syntax projection has no spinnerWaiter-visible UI

  // The 15-minute project session renews from the page itself (the request
  // the app's keepalive makes), through the config worker's gate, for the
  // same member: a fresh expiry, no sign-in page.
  const renewal = await page.evaluate(async () => {
    const response = await fetch("/_iterate/auth/refresh?return_to=%2F", {
      credentials: "same-origin",
      method: "POST",
    });
    return { body: (await response.json()) as { expiresAt?: number }, status: response.status };
  });
  expect(renewal).toMatchObject({ status: 200 });
  expect(renewal.body.expiresAt! * 1000).toBeGreaterThan(Date.now() + 14 * 60_000);

  // A live session that dies under the editor (a laptop waking, a colo
  // hiccup) comes back by itself, and edits made after it landed sync
  // through the replacement session.
  const socketClose = await page.evaluate(() => {
    const sockets = (window as unknown as { __sockets: WebSocket[] }).__sockets;
    const openSockets = sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length;
    const closedAt = new Date().toISOString();
    for (const socket of sockets) {
      socket.close();
    }
    return { closedAt, openSockets, sockets: sockets.length };
  });
  expect(socketClose.openSockets).toBeGreaterThan(0);
  await testInfo.attach("intentional-websocket-close", {
    body: JSON.stringify({ documentPath, projectSlug: slug, ...socketClose }, null, 2),
    contentType: "application/json",
  });
  await appendAtEnd(page, "\n\nStill here after the socket dropped.");
  await page.getByText(/^live · v\d+$/).waitFor({ timeout: 30_000 }); // timeout: the pull loop's backoff before its re-dial — the a11y-only badge gives the spinner-waiter nothing to watch
  await expect
    .poll(async () => String(await workspace.readFile(documentPath)), {
      timeout: 30_000, // timeout: a workspace read over RPC — no loading UI for the spinner-waiter
    })
    .toContain("Still here after the socket dropped.");
  expect(readReview((await workspace.readFile(documentPath))!).projection.markdown).toMatch(
    /REMOTE_KEPT\n{2,}Reviewed in Docs\.\n{2,}Still here after the socket dropped\./,
  );

  await page.getByRole("button", { name: "Rich editing", exact: true }).click();

  await page.getByRole("button", { name: "Comment on document" }).click();
  await page
    .getByPlaceholder("Comment on the entire document…")
    .fill("Please add a short owner summary before sharing.");
  await page.getByRole("button", { name: "Add document comment" }).click();
  const commentsPanel = page.getByRole("complementary");
  await commentsPanel
    .getByText("Please add a short owner summary before sharing.", { exact: true })
    .waitFor();
  await commentsPanel.getByRole("heading", { name: "Whole document", exact: true }).waitFor();

  await commentsPanel
    .getByText("Can we make this promise more concrete?", { exact: true })
    .waitFor();
  await commentsPanel.getByRole("heading", { name: "Selected text", exact: true }).waitFor();

  // Comments render optimistically, just like typing. Wait for the shared
  // editor protocol to persist both edits before checking durable source.
  await expect
    .poll(async () => readReview((await workspace.readFile(documentPath))!).threads.length)
    .toBe(2);
  const saved = await workspace.readFile(documentPath);
  expect(saved).not.toBeNull();
  const review = readReview(saved!);
  expect(review).toMatchObject({ diagnostics: [] });
  expect(review.threads).toHaveLength(2);
  expect(review.threads.find((thread) => thread.anchor)?.comments[0]?.body).toBe(
    "Can we make this promise more concrete?",
  );
  // Browser paragraph selection includes its final line break; the RFM anchor
  // preserves that live selection after the peer prepended source text.
  expect(saved).toContain("{==Make review decisions directly in the workspace file.\n==}");
  // Endmatter is hidden in rich mode. The real native EOF edits must retain
  // their paragraph breaks and order immediately before it, not concatenate
  // into the last visible line or spill into the YAML footer.
  expect(saved).toMatch(
    /\n{2,}REMOTE_KEPT\n{2,}Reviewed in Docs\.\n{2,}Still here after the socket dropped\.\n+---\ncomments:\n/,
  );
  expect(saved).toContain("\ncomments:");

  await page.reload();
  await page.getByText(/^live · v\d+$/).waitFor();
  await page.getByText("Docs review walkthrough", { exact: true }).waitFor();
  await page.getByText("Can we make this promise more concrete?", { exact: true }).waitFor();
  await testInfo.attach("roughdraft-desktop", {
    body: await page.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "Comment on document" }).click();
  await page
    .getByRole("dialog")
    .getByText("Can we make this promise more concrete?", { exact: true })
    .waitFor();
  await testInfo.attach("roughdraft-mobile", {
    body: await page.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });
  await peer.close();
});

async function appendAtEnd(page: import("@playwright/test").Page, text: string): Promise<void> {
  const editor = page.locator(".cm-content");
  await editor.click();
  // Select-all + ArrowRight parks the cursor at the end on macOS and Linux;
  // Cmd/Ctrl+End is not a consistent CodeMirror binding across both.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ArrowRight");
  // One native input event keeps a concurrent end-of-file insertion atomic.
  // Character-by-character concurrent typing is already exercised in the two
  // distinct table cells above, without making this marker proof interleave.
  await page.keyboard.insertText(text);
}

async function replaceCellWord(
  page: import("@playwright/test").Page,
  current: string,
  replacement: string,
): Promise<void> {
  const cell = page.locator(".cm-markdown-table-cell", { hasText: current });
  const bounds = await cell.boundingBox();
  if (!bounds) throw new Error(`Table cell ${JSON.stringify(current)} is not visible.`);
  // The cell is wider than its word. Double-click inside the visible text,
  // not its whitespace, to exercise the browser's native word selection.
  await cell.dblclick({ position: { x: Math.min(20, bounds.width / 2), y: bounds.height / 2 } });
  await expect
    .poll(() => cell.evaluate((element) => element.ownerDocument.getSelection()?.toString()), {
      timeout: 1_000, // timeout: native selection is synchronous and has no spinnerWaiter-visible progress
    })
    .toBe(current);
  await page.keyboard.type(replacement);
}

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
