import { test } from "./test-support/test.ts";

/**
 * PR #2375 demo recording: the tasks board as a GUEST lens on an agent's
 * workspace, live on preview-9. Drives the real project-member gate (fixed
 * test OTP), then the board: workspace-first breadcrumbs, uncommitted joke
 * cards from the agent's overlay, and a guest state-change written through
 * the lens. Run with VIDEO_MODE=1 for the rendered walkthrough.
 *
 * Environment-pinned on purpose (the lens-demo-live project and the agent
 * workspace exist on preview-9 with the tasks vessel knob set); skipped
 * everywhere else.
 */
const BOARD_URL =
  "https://tasks--lens-demo-live.iterate-preview-9.app/w?workspace=%2Fworkspaces%2Fagents%2Fweb%2F2026-07-31t20-18-24-992z&repo=%2Frepos%2Fconfig";

test("workspace lens board demo", async ({ page }) => {
  test.skip(
    !(process.env.APP_CONFIG_BASE_URL ?? "").includes("preview-9"),
    "demo spec for the preview-9 lens-demo-live project only",
  );
  test.setTimeout(300_000);

  await page.goto(BOARD_URL);

  // The project-member gate: sign in with the fixed-OTP test identity.
  await page.getByRole("link", { name: "Continue with iterate" }).click();
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.getByLabel("Email").fill("demo2+test@nustom.com");
  await page.getByRole("button", { name: "Send verification code" }).click();
  await page.getByLabel("Verification code").fill("424242");
  await page.getByRole("button", { name: "Continue with email" }).click();

  // The guest board over the agent's workspace: hierarchy breadcrumbs and
  // the agent's uncommitted joke tasks.
  await page.getByText("GUEST").waitFor({ timeout: 60_000 });
  await page.getByText("/repos/config").first().waitFor();
  await page.getByRole("button", { name: /Joke 3/ }).click();

  // A guest edit: move the card to In review — it lands in the agent's
  // uncommitted overlay (no Commit control anywhere on a guest lens).
  await page.getByRole("combobox", { name: "Task state" }).click();
  await page.getByRole("option", { name: "In review" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "In review" }).waitFor();
});
