// oxlint-disable iterate/spec-restricted-syntax
import { type Page, expect } from "@playwright/test";
import { createOrganization, createProject, login, sidebarButton, test } from "./test-helpers.ts";
import { spinnerWaiter } from "./plugins/spinner-waiter.ts";

type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function createMachineFromUi(page: Page, machineName: string) {
  await sidebarButton(page, "Machines").click();
  await page
    .getByRole("link", { name: "Create Machine" })
    .or(page.getByRole("button", { name: "Create Machine" }))
    .click();

  await page.getByPlaceholder("Machine name").fill(machineName);
  await page.getByRole("button", { name: "Create" }).click();

  await spinnerWaiter.settings.run({ spinnerTimeout: 300_000 }, async () => {
    await page.getByRole("heading", { name: "Active Machine", exact: true }).waitFor();
  });
}

async function openMachineDetail(page: Page, machineName: string): Promise<string> {
  await sidebarButton(page, "Machines").click();
  await page.getByRole("link", { name: machineName }).first().click();
  const iterateHref = await page.getByRole("link", { name: /^Iterate$/ }).getAttribute("href");
  if (!iterateHref) throw new Error("Iterate service link missing on machine detail page");
  return iterateHref;
}

function buildDaemonBaseUrl(iterateBaseUrl: string): string {
  const parsed = new URL(iterateBaseUrl);
  return `${parsed.protocol}//3001__${parsed.host}`;
}

async function execDaemonCommand(
  page: Page,
  daemonBaseUrl: string,
  command: string[],
): Promise<ExecResult> {
  const response = await page.request.post(`${daemonBaseUrl}/api/orpc/tool/execCommand`, {
    data: { command },
  });
  expect(response.ok()).toBeTruthy();

  const body = (await response.json()) as Record<string, unknown>;
  const result = (body.result ?? body) as Record<string, unknown>;
  return {
    exitCode: Number(result.exitCode ?? 0),
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

test.describe("machine persistence", () => {
  test("dotfile sync persists ~/.iterate file across machine replacement", async ({ page }) => {
    test.setTimeout(900_000);
    test.skip(
      process.env.MACHINE_PERSISTENCE_SPEC !== "1",
      "Set MACHINE_PERSISTENCE_SPEC=1 to run machine persistence specs",
    );

    const now = Date.now();
    const testEmail = `persist-dotfiles-${now}+test@nustom.com`;
    const machineA = `Persist A ${now}`;
    const machineB = `Persist B ${now}`;
    const marker = `dotfile-sync-${now}`;
    const markerPath = "~/.iterate/spec-dotfile-sync.txt";

    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    await createMachineFromUi(page, machineA);
    const machineAIterateUrl = await openMachineDetail(page, machineA);
    const machineADaemonUrl = buildDaemonBaseUrl(machineAIterateUrl);
    const writeResult = await execDaemonCommand(page, machineADaemonUrl, [
      "bash",
      "-lc",
      `printf '%s' '${marker}' > ${markerPath} && cat ${markerPath}`,
    ]);
    expect(writeResult.exitCode).toBe(0);
    expect(writeResult.stdout).toContain(marker);

    await createMachineFromUi(page, machineB);
    const machineBIterateUrl = await openMachineDetail(page, machineB);
    const machineBDaemonUrl = buildDaemonBaseUrl(machineBIterateUrl);
    const readResult = await execDaemonCommand(page, machineBDaemonUrl, [
      "bash",
      "-lc",
      `cat ${markerPath}`,
    ]);
    expect(readResult.exitCode).toBe(0);
    expect(readResult.stdout).toContain(marker);
  });

  test("opencode sqlite db persists across machine replacement", async ({ page }) => {
    test.setTimeout(900_000);
    test.skip(
      process.env.MACHINE_PERSISTENCE_SPEC !== "1",
      "Set MACHINE_PERSISTENCE_SPEC=1 to run machine persistence specs",
    );

    const now = Date.now();
    const testEmail = `persist-opencode-${now}+test@nustom.com`;
    const machineA = `OpenCode A ${now}`;
    const machineB = `OpenCode B ${now}`;
    const marker = `banana-${now}`;
    const key = "opencode-session-marker";

    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    await createMachineFromUi(page, machineA);
    const machineAIterateUrl = await openMachineDetail(page, machineA);
    const machineADaemonUrl = buildDaemonBaseUrl(machineAIterateUrl);

    const writeResult = await execDaemonCommand(page, machineADaemonUrl, [
      "bash",
      "-lc",
      [
        'opencode db "CREATE TABLE IF NOT EXISTS iterate_sync_e2e (k TEXT PRIMARY KEY, v TEXT NOT NULL);',
        `INSERT INTO iterate_sync_e2e(k, v) VALUES ('${key}', '${marker}') ON CONFLICT(k) DO UPDATE SET v=excluded.v;`,
        `SELECT v FROM iterate_sync_e2e WHERE k='${key}';"`,
      ].join(" "),
    ]);
    expect(writeResult.exitCode).toBe(0);
    expect(writeResult.stdout).toContain(marker);

    await createMachineFromUi(page, machineB);
    const machineBIterateUrl = await openMachineDetail(page, machineB);
    const machineBDaemonUrl = buildDaemonBaseUrl(machineBIterateUrl);
    const readResult = await execDaemonCommand(page, machineBDaemonUrl, [
      "bash",
      "-lc",
      `opencode db "SELECT v FROM iterate_sync_e2e WHERE k='${key}';"`,
    ]);
    expect(readResult.exitCode).toBe(0);
    expect(readResult.stdout).toContain(marker);
  });
});
