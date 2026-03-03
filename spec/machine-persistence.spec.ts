import { execSync } from "node:child_process";
import { type Page, expect } from "@playwright/test";
import { spinnerWaiter } from "./plugins/spinner-waiter.ts";
import { createOrganization, createProject, login, sidebarButton, test } from "./test-helpers.ts";

// Resolve the image tag to use for machine creation.
// Priority: SANDBOX_IMAGE_TAG -> DOCKER_DEFAULT_IMAGE -> FLY_DEFAULT_IMAGE.
function resolveImageTag(): string {
  if (process.env.SANDBOX_IMAGE_TAG) return process.env.SANDBOX_IMAGE_TAG;
  try {
    const dockerDefault = execSync("doppler run -- sh -c 'echo $DOCKER_DEFAULT_IMAGE'", {
      encoding: "utf-8",
    }).trim();
    if (dockerDefault) return dockerDefault;
    return execSync("doppler run -- sh -c 'echo $FLY_DEFAULT_IMAGE'", { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

async function createMachineFromUi(page: Page, machineName: string, imageTag?: string) {
  await sidebarButton(page, "Machines").click();
  await page
    .getByRole("link", { name: "Create Machine" })
    .or(page.getByRole("button", { name: "Create Machine" }))
    .click();

  await page.getByPlaceholder("Machine name").fill(machineName);

  if (imageTag) {
    const imageInput = page.getByRole("textbox", {
      name: /iterate-sandbox:sha-<shortSha>|leave blank for default/i,
    });
    await imageInput.fill(imageTag);
  }

  await page.getByRole("button", { name: "Create" }).click();

  // Wait for the machine to appear in the list (may need a re-fetch cycle).
  const machineLink = page.getByRole("link", { name: machineName }).first();
  await machineLink.waitFor({ timeout: 30_000 });
  await machineLink.click();

  await spinnerWaiter.settings.run({ spinnerTimeout: 360_000 }, async () => {
    await page
      .locator("dd")
      .filter({ hasText: /^active$/ })
      .waitFor();
  });
}

/** Run a shell command on the machine via the "Run command" button on the detail page. */
async function runCommandOnMachine(page: Page, command: string): Promise<string> {
  await page.evaluate((cmd) => (window.prompt = () => cmd), command);
  await page.getByRole("button", { name: "Run command" }).click();
  const resultBlock = page.getByTestId("exec-command-result");
  await resultBlock.waitFor();
  return (await resultBlock.textContent()) ?? "";
}

test.describe("machine persistence", () => {
  test("~/.local/share/iterate file persists across machine replacement", async ({ page }) => {
    test.setTimeout(900_000);
    test.skip(
      process.env.MACHINE_PERSISTENCE_SPEC !== "1",
      "Set MACHINE_PERSISTENCE_SPEC=1 to run machine persistence specs",
    );

    const imageTag = resolveImageTag();
    const now = Date.now();
    const testEmail = `persist-files-${now}+test@nustom.com`;
    const machineA = `Persist A ${now}`;
    const machineB = `Persist B ${now}`;
    const marker = `persist-marker-${now}`;
    const markerPath = "~/.local/share/iterate/spec-marker.txt";

    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    // Machine A: create, write a marker file to the persisted directory.
    await createMachineFromUi(page, machineA, imageTag);
    const writeOutput = await runCommandOnMachine(
      page,
      `mkdir -p ~/.local/share/iterate && printf '%s' '${marker}' > ${markerPath} && cat ${markerPath}`,
    );
    expect(writeOutput).toContain(marker);

    // Machine B: replace machine, read the marker file back.
    await createMachineFromUi(page, machineB, imageTag);
    const readOutput = await runCommandOnMachine(page, `cat ${markerPath}`);
    expect(readOutput).toContain(marker);
  });

  test("webchat conversation persists across machine replacement", async ({ page }) => {
    test.setTimeout(900_000);
    test.skip(
      process.env.MACHINE_PERSISTENCE_SPEC !== "1",
      "Set MACHINE_PERSISTENCE_SPEC=1 to run machine persistence specs",
    );

    const imageTag = resolveImageTag();
    const now = Date.now();
    const testEmail = `persist-webchat-${now}+test@nustom.com`;
    const machineA = `Chat A ${now}`;
    const machineB = `Chat B ${now}`;

    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    // Machine A: create, activate, then send a message via the webchat UI.
    await createMachineFromUi(page, machineA, imageTag);
    await sidebarButton(page, "Home").click();
    await page.getByTestId("webchat-input").fill("the secret word is banana");
    await page.getByTestId("webchat-send").click();
    await page.getByTestId("webchat-message-assistant").waitFor();

    // Machine B: replace machine, then ask for the secret word in the same thread.
    await createMachineFromUi(page, machineB, imageTag);
    await sidebarButton(page, "Home").click();
    await page
      .getByTestId("webchat-input")
      .fill("what's the secret word? reply with just the word");
    await page.getByTestId("webchat-send").click();
    await page.getByTestId("webchat-message-assistant").getByText("banana").waitFor();
  });
});
