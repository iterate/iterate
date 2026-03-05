import { expect } from "@playwright/test";
import { createOrganization, createProject, login, sidebarButton, test } from "./test-helpers.ts";
import { spinnerWaiter } from "./plugins/spinner-waiter.ts";

test.describe("project home webchat", () => {
  test("shows webchat UI with machine prerequisite when no machine", async ({ page }) => {
    const testEmail = `webchat-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    await sidebarButton(page, "Home").click();

    // Header action
    await page.getByRole("button", { name: "New Thread" }).waitFor();

    // Machine prerequisite card
    await page.getByText("No active machine").waitFor();
    await page.getByText("Webchat runs through your active machine").waitFor();
    await page.getByRole("link", { name: "Open machines" }).waitFor();

    // Thread sidebar empty state
    await page.getByText("No threads yet").waitFor();
    await page.getByText("Send a first message to start a thread.").waitFor();

    // Message area empty state
    await page.getByText("Start a new thread").waitFor();

    // Input is present but disabled (no machine)
    await page.getByTestId("webchat-input").and(page.locator("[disabled]")).waitFor();

    // Send button is disabled
    await page.getByTestId("webchat-send").and(page.locator("[disabled]")).waitFor();
  });

  test("open machines link navigates to machines page", async ({ page }) => {
    const testEmail = `webchat-nav-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    await sidebarButton(page, "Home").click();
    await page.getByRole("link", { name: "Open machines" }).click();

    // Should be on machines page
    await page.getByRole("link", { name: "Create Machine" }).waitFor();
  });

  test("new thread button resets to compose state", async ({ page }) => {
    const testEmail = `webchat-new-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    await sidebarButton(page, "Home").click();
    await page.getByRole("button", { name: "New Thread" }).click();

    // Message area shows compose empty state
    await page.getByText("Start a new thread").waitFor();
  });

  test("file attach button is disabled without active machine", async ({ page }) => {
    const testEmail = `webchat-attach-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    await sidebarButton(page, "Home").click();

    // The paperclip/attach button should be disabled
    await page
      .locator("button[disabled]")
      .filter({ has: page.locator("svg.lucide-paperclip") })
      .waitFor();
  });

  test("input shows shift+enter hint", async ({ page }) => {
    const testEmail = `webchat-hint-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    await sidebarButton(page, "Home").click();
    await page.getByText("Shift+Enter for newline. Enter to send.").waitFor();
  });

  test("can send and receive in a webchat thread", async ({ page }) => {
    test.setTimeout(300_000); // machine provisioning + push-setup pipeline + LLM round-trips
    test.skip(
      process.env.WEBCHAT_LLM_SPEC !== "1",
      "Set WEBCHAT_LLM_SPEC=1 to run the LLM-backed webchat spec",
    );

    const testEmail = `webchat-live-${Date.now()}+test@nustom.com`;
    const machineName = `Webchat Machine ${Date.now()}`;

    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    // Create a machine (provider inherited from project settings)
    await sidebarButton(page, "Machines").click();
    await page.getByRole("link", { name: "Create Machine" }).click();

    await page.getByPlaceholder("Machine name").fill(machineName);
    await page.getByRole("button", { name: "Create" }).click();

    // Machine pipeline: create → provision (50-120s) → setup → 30s delay → probe → activate.
    // We expect that the UI shows an informative spinner throughout. This should fail within 1s if the spinner goes away at any point.
    await spinnerWaiter.settings.run({ spinnerTimeout: 240_000 }, async () => {
      await page.getByRole("heading", { name: "Active Machine", exact: true }).waitFor();
    });

    // Navigate to home — prerequisite card should be gone, input enabled
    await sidebarButton(page, "Home").click();
    await page.getByTestId("webchat-input").and(page.locator(":not([disabled])")).waitFor();

    // Dismiss lingering toasts that may overlay the Send button
    await page
      .locator("[data-sonner-toast]")
      .first()
      .waitFor({ state: "hidden", timeout: 10000 })
      .catch(() => {});

    // Start a new thread (exact match avoids hitting thread buttons that contain "New thread" text)
    await page.getByRole("button", { name: "New Thread", exact: true }).click();
    const input = page.getByTestId("webchat-input");
    await input.fill("Reply with exactly: ACK");
    await page.getByTestId("webchat-send").click();

    // User message appears with correct text
    await page
      .getByTestId("webchat-message-user")
      .filter({ hasText: "Reply with exactly: ACK" })
      .waitFor({ timeout: 15000 });

    // Thread appears in sidebar
    await page.locator("[data-testid^='webchat-thread-']").first().waitFor({ timeout: 30000 });

    // Assistant response appears with non-empty text
    await page.getByTestId("webchat-message-assistant").first().waitFor({ timeout: 120000 });
    await expect
      .poll(
        async () => {
          const text = await page.getByTestId("webchat-message-assistant").last().innerText();
          return text.trim().length;
        },
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);

    // Thread title in sidebar is populated
    await expect
      .poll(
        async () => {
          const title = await page
            .locator("[data-testid^='webchat-thread-']")
            .first()
            .locator("p")
            .first()
            .innerText();
          return title.trim().length;
        },
        { timeout: 10000 },
      )
      .toBeGreaterThan(0);

    // Can send a follow-up in the same thread
    await input.fill("Reply with exactly: ACK2");
    await page.getByTestId("webchat-send").click();

    // Should have 2 user messages
    await page
      .getByTestId("webchat-message-user")
      .filter({ hasText: "ACK2" })
      .waitFor({ timeout: 15000 });

    // And eventually 2 assistant messages
    await expect
      .poll(() => page.getByTestId("webchat-message-assistant").count(), { timeout: 120000 })
      .toBeGreaterThan(1);
  });
});
