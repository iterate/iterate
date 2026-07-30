import { fileURLToPath } from "node:url";
import {
  DEFAULT_DEVICE_ID,
  findFirmwareDevice,
  M5STICKS3_CONFIGURATION_PARTITION,
} from "../src/firmware/catalog.ts";
import { flashFirmwareWithEsptool } from "../src/firmware/esptool-cli.ts";
import { parseLocalFlashCliOptions } from "../src/firmware/flash-cli-options.ts";
import { prepareLocalEspIdfFlashPlan } from "../src/firmware/local-idf-build.ts";

const usage = `Usage:
  pnpm firmware:flash -- --port /dev/cu.usbmodemNNN [options]

Non-secret options:
  --port <path>             Serial port (or ITERATE_KIT_PORT)
  --wifi-ssid <name>        Wi-Fi SSID (or ITERATE_KIT_WIFI_SSID)
  --project-id <prj_...>    Stable Iterate project ID (or ITERATE_KIT_PROJECT_ID)
  --base-url <origin>       OS origin (default: https://os.iterate.com)
  --build-directory <path>  ESP-IDF build (default: .build/m5sticks3)
  --dry-run                 Validate and report the exact plan without flashing

Required secret environment variables:
  ITERATE_KIT_WIFI_PASSWORD
  ITERATE_KIT_PROJECT_API_KEY

The CLI deliberately has no password or API-key flags, keeping secrets out of
shell history and process listings.`;

export async function flashLocalM5StickS3(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  workingDirectory: string,
) {
  const options = parseLocalFlashCliOptions(args, environment, workingDirectory);
  const device = findFirmwareDevice(DEFAULT_DEVICE_ID);
  if (!device || device.id !== "m5sticks3") {
    throw new Error("The M5StickS3 firmware target is missing from the catalog.");
  }
  const plan = await prepareLocalEspIdfFlashPlan({
    buildDirectory: options.buildDirectory,
    configuration: options.configuration,
    configurationPartition: M5STICKS3_CONFIGURATION_PARTITION,
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

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file:"))
) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage);
  } else {
    try {
      const result = await flashLocalM5StickS3(process.argv.slice(2), process.env, process.cwd());
      if (process.argv.includes("--dry-run")) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log("M5StickS3 firmware and provisioning image verified and flashed.");
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
