// oxlint-disable iterate/spec-restricted-syntax
import { execSync } from "node:child_process";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { type Page, expect } from "@playwright/test";
import type { AppRouter } from "../apps/daemon/server/orpc/app-router.ts";
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

function createDaemonClient(daemonBaseUrl: string, page: Page): RouterClient<AppRouter> {
  const link = new RPCLink({
    url: `${daemonBaseUrl}/api/orpc`,
    // Playwright's page.request.fetch carries auth-bridge cookies automatically.
    fetch: (input, init) =>
      page.request.fetch(input as any, {
        timeout: 10_000,
        ...(init as any),
      }) as any,
  });
  return createORPCClient(link);
}

async function createMachineFromUi(page: Page, machineName: string, imageTag?: string) {
  await sidebarButton(page, "Machines").click();
  await page
    .getByRole("link", { name: "Create Machine" })
    .or(page.getByRole("button", { name: "Create Machine" }))
    .click();

  await page.getByPlaceholder("Machine name").fill(machineName);

  // Fill in the image tag if provided (overrides the Doppler default in the dev server)
  if (imageTag) {
    const imageInput = page.getByRole("textbox", {
      name: /iterate-sandbox:sha-<shortSha>|leave blank for default/i,
    });
    await imageInput.fill(imageTag);
  }

  await page.getByRole("button", { name: "Create" }).click();

  // Navigate to this machine's detail page. The DaemonStatus component renders
  // <Spinner aria-label="Loading"> while state === "starting", and the detail page
  // polls every 3s in that state. spinner-waiter holds until the spinner clears
  // (machine activated), then the waitFor resolves immediately.
  await page.getByRole("link", { name: machineName }).first().click();

  await spinnerWaiter.settings.run({ spinnerTimeout: 360_000 }, async () => {
    await page
      .locator("dd")
      .filter({ hasText: /^active$/ })
      .waitFor();
  });
}

async function openMachineDetail(page: Page, machineName: string): Promise<string> {
  await sidebarButton(page, "Machines").click();
  await page.getByRole("link", { name: machineName }).first().click();
  // The service link renders as "Iterate :3000" (name + port).
  const iterateLink = page.getByRole("link", { name: /^Iterate\b/ }).first();
  await iterateLink.waitFor({ timeout: 120_000 });
  const iterateHref = await iterateLink.getAttribute("href");
  if (!iterateHref) throw new Error("Iterate service link missing on machine detail page");
  return iterateHref;
}

function buildDaemonBaseUrl(iterateBaseUrl: string): string {
  const parsed = new URL(iterateBaseUrl);
  return `${parsed.protocol}//3001__${parsed.host}`;
}

type WebchatMessage = { role: "user" | "assistant"; text: string; messageId?: string };

async function postWebchatMessage(
  page: Page,
  daemonBaseUrl: string,
  input: { threadId: string; messageId: string; text: string },
) {
  const response = await page.request.post(`${daemonBaseUrl}/api/integrations/webchat/webhook`, {
    data: {
      type: "webchat:message",
      threadId: input.threadId,
      messageId: input.messageId,
      text: input.text,
      userId: "spec",
      userName: "Spec Test",
      createdAt: Date.now(),
    },
    timeout: 10_000,
  });
  if (!response.ok()) {
    throw new Error(
      `Failed to post webchat message: ${response.status()} ${await response.text()}`.slice(0, 300),
    );
  }
  return response;
}

async function waitForAssistantReply(
  page: Page,
  daemonBaseUrl: string,
  input: { threadId: string; afterMessageId: string; timeoutMs?: number },
): Promise<WebchatMessage> {
  const timeoutMs = input.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await page.request.get(
      `${daemonBaseUrl}/api/integrations/webchat/threads/${encodeURIComponent(input.threadId)}/messages`,
      { timeout: 10_000 },
    );

    if (response.ok()) {
      const body = (await response.json()) as { messages?: WebchatMessage[] };
      const messages = body.messages ?? [];
      const userIndex = messages.findIndex((m) => m.messageId === input.afterMessageId);
      const from = userIndex >= 0 ? userIndex + 1 : 0;
      const assistantReply = messages
        .slice(from)
        .find((m) => m.role === "assistant" && m.text.trim());
      if (assistantReply) return assistantReply;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Timed out waiting for assistant reply in thread ${input.threadId}`);
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

    await createMachineFromUi(page, machineA, imageTag);
    const machineAIterateUrl = await openMachineDetail(page, machineA);
    const machineADaemonUrl = buildDaemonBaseUrl(machineAIterateUrl);
    const daemonA = createDaemonClient(machineADaemonUrl, page);
    const writeResult = await daemonA.tool.execCommand({
      command: [
        "bash",
        "-lc",
        `mkdir -p ~/.local/share/iterate && printf '%s' '${marker}' > ${markerPath} && cat ${markerPath}`,
      ],
    });
    expect(writeResult.exitCode).toBe(0);
    expect(writeResult.stdout).toContain(marker);

    await createMachineFromUi(page, machineB, imageTag);
    const machineBIterateUrl = await openMachineDetail(page, machineB);
    const machineBDaemonUrl = buildDaemonBaseUrl(machineBIterateUrl);
    const daemonB = createDaemonClient(machineBDaemonUrl, page);
    const readResult = await daemonB.tool.execCommand({
      command: ["bash", "-lc", `cat ${markerPath}`],
    });
    expect(readResult.exitCode).toBe(0);
    expect(readResult.stdout).toContain(marker);
  });

  test("webchat conversation persists across machine replacement", async ({ page }) => {
    test.setTimeout(900_000);
    test.skip(
      process.env.MACHINE_PERSISTENCE_SPEC !== "1",
      "Set MACHINE_PERSISTENCE_SPEC=1 to run machine persistence specs",
    );

    const imageTag = resolveImageTag();
    const now = Date.now();
    const testEmail = `persist-opencode-${now}+test@nustom.com`;
    const machineA = `OpenCode A ${now}`;
    const machineB = `OpenCode B ${now}`;
    const threadId = `persist-thread-${now}`;

    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    await createMachineFromUi(page, machineA, imageTag);
    const machineAIterateUrl = await openMachineDetail(page, machineA);
    const machineADaemonUrl = buildDaemonBaseUrl(machineAIterateUrl);

    const machineAUserMessageId = `msg-a-${now}`;
    await postWebchatMessage(page, machineADaemonUrl, {
      threadId,
      messageId: machineAUserMessageId,
      text: "the secret word is banana",
    });

    await waitForAssistantReply(page, machineADaemonUrl, {
      threadId,
      afterMessageId: machineAUserMessageId,
    });

    await createMachineFromUi(page, machineB, imageTag);
    const machineBIterateUrl = await openMachineDetail(page, machineB);
    const machineBDaemonUrl = buildDaemonBaseUrl(machineBIterateUrl);

    const machineBUserMessageId = `msg-b-${now}`;
    await postWebchatMessage(page, machineBDaemonUrl, {
      threadId,
      messageId: machineBUserMessageId,
      text: "what's the secret word? reply with just the word",
    });

    const machineBReply = await waitForAssistantReply(page, machineBDaemonUrl, {
      threadId,
      afterMessageId: machineBUserMessageId,
    });
    expect(machineBReply.text.toLowerCase()).toContain("banana");
  });
});
