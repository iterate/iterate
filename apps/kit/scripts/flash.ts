import { fileURLToPath } from "node:url";
import { findFirmwareDevice } from "../src/firmware/catalog.ts";
import { flashFirmwareWithEsptool } from "../src/firmware/esptool-cli.ts";
import { parseLocalFlashCliOptions } from "../src/firmware/flash-cli-options.ts";
import { prepareLocalEspIdfFlashPlan } from "../src/firmware/local-idf-build.ts";

const usage = `Usage:
  pnpm firmware:flash -- --port /dev/cu.usbmodemNNN [options]

Non-secret options:
  --device <catalog-id>      Firmware target (default: m5sticks3)
  --port <path>             Serial port (or ITERATE_KIT_PORT)
  --wifi-ssid <name>        Wi-Fi SSID (or ITERATE_KIT_WIFI_SSID)
  --project-id <prj_...>    Stable Iterate project ID (or ITERATE_KIT_PROJECT_ID)
  --base-url <origin>       OS origin (default: https://os.iterate.com)
  --pcm-base-url <origin>   Userspace /pcm origin (defaults to --base-url)
  --build-directory <path>  ESP-IDF build (default: .build/m5sticks3)
  --dry-run                 Validate and report the exact plan without flashing

Required secret environment variables:
  ITERATE_KIT_WIFI_PASSWORD
  ITERATE_KIT_PROJECT_API_KEY

The CLI deliberately has no password or API-key flags, keeping secrets out of
shell history and process listings.`;

export async function flashLocalFirmware(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  workingDirectory: string,
) {
  const options = parseLocalFlashCliOptions(args, environment, workingDirectory);
  const device = findFirmwareDevice(options.deviceId);
  if (!device) {
    throw new Error(
      `Firmware target ${JSON.stringify(options.deviceId)} is missing from the catalog.`,
    );
  }
  const plan = await prepareLocalEspIdfFlashPlan({
    buildDirectory: options.buildDirectory,
    configuration: options.configuration,
    device,
  });
  const summary = {
    chipFamily: plan.chipFamily,
    device: device.id,
    parts: plan.parts.map((part) => ({
      address: `0x${part.address.toString(16)}`,
      bytes: part.data.byteLength,
      label: part.label,
    })),
    totalBytes: plan.parts.reduce((total, part) => total + part.data.byteLength, 0),
  };
  if (options.dryRun) return summary;

  console.log(JSON.stringify(summary, null, 2));
  await flashFirmwareWithEsptool(plan, {
    port: options.port,
    pythonExecutable: environment.ITERATE_KIT_PYTHON,
  });
  return summary;
}

/**
 * Existing Stick evidence scripts retain this name so their reviewed command
 * lines do not churn. The implementation is the same multi-device path used by
 * the public CLI; rejecting another target here prevents a Stick-specific proof
 * script from accidentally erasing adjacent hardware.
 */
export async function flashLocalM5StickS3(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  workingDirectory: string,
) {
  const options = parseLocalFlashCliOptions(args, environment, workingDirectory);
  if (options.deviceId !== "m5sticks3") {
    throw new Error("The M5StickS3 proof flasher only accepts --device m5sticks3.");
  }
  return flashLocalFirmware(args, environment, workingDirectory);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file:"))
) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage);
  } else {
    try {
      const result = await flashLocalFirmware(process.argv.slice(2), process.env, process.cwd());
      if (process.argv.includes("--dry-run")) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log("Firmware and provisioning image verified and flashed.");
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
