import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { M5STICKS3_CONFIGURATION_PARTITION } from "../src/firmware/catalog.ts";
import { decodeDeviceConfiguration } from "../src/firmware/config-image.ts";
import { readFlashRegionWithEsptool } from "../src/firmware/esptool-cli.ts";
import { flashLocalM5StickS3 } from "./flash.ts";
import { installUserspaceWorkerFromCli } from "./install-userspace-worker.ts";
import { proveProductionM5StickS3Grok } from "./prove-production-m5sticks3-grok.ts";
import { proveProductionM5StickS3Tone } from "./prove-production-m5sticks3-tone.ts";

const run = promisify(execFile);
const defaultPort = "/dev/cu.usbmodem11201";
const defaultDeviceHost = "192.168.0.21";
const defaultWorkerHost = "kit--kit-stick-vertical-proof.iterate.app";
const defaultProjectSlug = "kit-stick-vertical-proof";
const packageDirectory = fileURLToPath(new URL("../", import.meta.url));

const port = process.env.ITERATE_KIT_PORT?.trim() || defaultPort;
const deviceHost = process.env.ITERATE_KIT_DEVICE_HOST?.trim() || defaultDeviceHost;
const workerHost = process.env.ITERATE_KIT_WORKER_HOST?.trim() || defaultWorkerHost;
const projectSlug = process.env.ITERATE_KIT_PROJECT_SLUG?.trim() || defaultProjectSlug;
const installUserspace = process.env.ITERATE_KIT_INSTALL_USERSPACE === "1";
const flashFirmware = process.env.ITERATE_KIT_FLASH_FIRMWARE === "1";
const mode = process.env.ITERATE_KIT_USERSPACE_MODE?.trim() || "grok";
if (mode !== "grok" && mode !== "tone") {
  throw new Error("ITERATE_KIT_USERSPACE_MODE must be either grok or tone.");
}

/*
 * The physical proof must use the exact credential already flashed on the
 * device. Reading it locally avoids a second test-only secret source and also
 * proves that the production-shaped provisioning image remains decodable.
 * esptool resets the chip after reading, so the runner deliberately waits for
 * both LAN reachability and the measured post-IP service-registration margin
 * before remotely driving the same firmware event processor. Optional fresh
 * flashing uses the repository's shared CLI implementation; this wrapper adds
 * orchestration, not another flashing protocol. It is intentionally unattended
 * and therefore records remote call/PTT provenance rather than asking anyone
 * to touch the top or front button.
 */
const image = await readFlashRegionWithEsptool({
  chipFamily: "ESP32-S3",
  port,
  pythonExecutable: process.env.ITERATE_KIT_PYTHON?.trim() || undefined,
  region: M5STICKS3_CONFIGURATION_PARTITION,
});
const configuration = decodeDeviceConfiguration(image);
/*
 * A fresh production test project deliberately replaces only the Iterate
 * credential fields. Wi-Fi remains a fact learned from the already-provisioned
 * physical device, while the explicit environment pair lets the harness move
 * away from a revoked project without ever printing either old or new secret.
 */
const projectId = process.env.ITERATE_KIT_PROJECT_ID?.trim() || configuration.iterate.projectId;
const projectApiKey =
  process.env.ITERATE_KIT_PROJECT_API_KEY?.trim() || configuration.iterate.projectApiKey;
console.log(
  `device_configuration_loaded project_id=${projectId} ` +
    `credential_source=${process.env.ITERATE_KIT_PROJECT_API_KEY ? "environment" : "device"} ` +
    "waiting_for_firmware_reconnect=true",
);

if (installUserspace) {
  const xaiApiKey = process.env.XAI_API_KEY?.trim() || process.env.APP_CONFIG_X_AI_API_KEY?.trim();
  const installed = await installUserspaceWorkerFromCli(
    [
      "--project-id",
      projectId,
      "--base-url",
      configuration.iterate.baseUrl,
      "--mode",
      mode,
      "--apply",
    ],
    {
      ...process.env,
      ITERATE_KIT_PROJECT_API_KEY: projectApiKey,
      XAI_API_KEY: xaiApiKey,
    },
  );
  console.log(
    `userspace_worker_installed commit_oid=${installed.commitOid} mode=${installed.mode}`,
  );
}

if (flashFirmware) {
  await flashLocalM5StickS3(
    [
      "--port",
      port,
      "--wifi-ssid",
      configuration.wifi.ssid,
      "--project-id",
      projectId,
      "--base-url",
      configuration.iterate.baseUrl,
      "--pcm-base-url",
      `https://${workerHost}`,
      "--build-directory",
      "firmware/targets/m5sticks3/build",
    ],
    {
      ...process.env,
      ITERATE_KIT_PROJECT_API_KEY: projectApiKey,
      ITERATE_KIT_WIFI_PASSWORD: configuration.wifi.password,
    },
    packageDirectory,
  );
  console.log("fresh_firmware_flashed target=m5sticks3");
}

const reachabilityDeadline = Date.now() + 60_000;
while (true) {
  try {
    await run("/sbin/ping", ["-c", "1", "-W", "1000", deviceHost]);
    break;
  } catch {
    if (Date.now() >= reachabilityDeadline) {
      throw new Error("Stick did not regain LAN reachability within 60 seconds after flash read.");
    }
    await delay(1_000);
  }
}

console.log("device_reachable waiting_for_pcm_registration=true");
await delay(18_000);

const proofEnvironment = {
  ...process.env,
  ITERATE_KIT_PROJECT_API_KEY: projectApiKey,
  ITERATE_KIT_PROJECT_ID: projectId,
};
const result =
  mode === "tone"
    ? await proveProductionM5StickS3Tone(["--device-host", deviceHost], proofEnvironment)
    : await proveProductionM5StickS3Grok(
        [
          "--device-host",
          deviceHost,
          "--worker-host",
          workerHost,
          "--project-id",
          projectId,
          "--project-slug",
          projectSlug,
          "--remote-ptt",
        ],
        proofEnvironment,
      );
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;
