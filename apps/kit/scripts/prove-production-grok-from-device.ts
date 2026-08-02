import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildProductionDeviceProofPlan,
  parseProductionDeviceProofCliOptions,
} from "../src/device/production-device-proof.ts";
import { findFirmwareDevice } from "../src/firmware/catalog.ts";
import { decodeDeviceConfiguration } from "../src/firmware/config-image.ts";
import { readFlashRegionWithEsptool } from "../src/firmware/esptool-cli.ts";
import { readLocalEspIdfNamedPartition } from "../src/firmware/local-idf-build.ts";
import { flashLocalFirmware } from "./flash.ts";
import { installUserspaceWorkerFromCli } from "./install-userspace-worker.ts";
import { proveProductionM5StickS3Grok } from "./prove-production-m5sticks3-grok.ts";
import { proveProductionM5StickS3Tone } from "./prove-production-m5sticks3-tone.ts";
import { proveProductionStackChanGrok } from "./prove-production-stackchan-grok.ts";

const executeFile = promisify(execFile);
const defaultPackageDirectory = fileURLToPath(new URL("../", import.meta.url));

export const productionDeviceProofUsage = `Usage:
  pnpm exec tsx scripts/prove-production-grok-from-device.ts [options]

Target and physical route:
  --device-id <catalog-id>   Target model (default: m5sticks3)
  --device-mac <AA:BB:...>  Stable USB serial / ROM MAC
  --port </dev/cu.*>        Freshly resolved current serial port
  --build-directory <path>  Compiled ESP-IDF target build
  --device-host <host>      Current LAN address used for attribution

Userspace/project route:
  --worker-host <host>
  --project-id <prj_...>
  --project-slug <slug>
  --output-directory <path>
  --turns <1..20>          Repeated PTT turns on one deployed /pcm session
  --install-userspace
  --flash-firmware

Secrets remain environment-only. The historical no-argument Stick defaults
are retained; non-Stick targets require their current port and LAN host.`;

/**
 * Runs the unattended physical proof for one catalogued ESP target.
 *
 * Esptool's read resets the board, so configuration recovery, optional flash,
 * reachability, and remote PTT remain one deliberately ordered transaction.
 * The operation never opens a diagnostic serial protocol and never prints the
 * decoded Wi-Fi password or project bearer.
 */
export async function proveProductionGrokFromDevice(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  packageDirectory = defaultPackageDirectory,
) {
  const options = parseProductionDeviceProofCliOptions(args, environment, packageDirectory);
  const device = findFirmwareDevice(options.deviceId);
  if (!device || device.installMethod.kind !== "esp-serial") {
    throw new Error(`${options.deviceId} is not an ESP serial target in the firmware catalog.`);
  }

  const configurationRegion = await readLocalEspIdfNamedPartition({
    buildDirectory: options.buildDirectory,
    device,
    partitionLabel: "iterate_kit",
  });
  const image = await readFlashRegionWithEsptool({
    chipFamily: device.installMethod.chipFamily,
    port: options.port,
    pythonExecutable: environment.ITERATE_KIT_PYTHON?.trim() || undefined,
    region: configurationRegion,
  });
  const configuration = decodeDeviceConfiguration(image);
  const plan = buildProductionDeviceProofPlan(options, configuration);
  const environmentProjectApiKey = environment.ITERATE_KIT_PROJECT_API_KEY?.trim();
  const projectApiKey = environmentProjectApiKey || configuration.iterate.projectApiKey;

  console.log(
    JSON.stringify({
      code: "production-device-configuration-loaded",
      credentialSource: environmentProjectApiKey ? "environment" : "device",
      configurationRegion,
      provenance: plan.provenance,
    }),
  );

  if (options.installUserspace) {
    const xaiApiKey =
      environment.XAI_API_KEY?.trim() || environment.APP_CONFIG_X_AI_API_KEY?.trim();
    const installed = await installUserspaceWorkerFromCli(
      [
        "--project-id",
        plan.projectId,
        "--base-url",
        configuration.iterate.baseUrl,
        "--mode",
        options.mode,
        "--apply",
      ],
      {
        ...environment,
        ITERATE_KIT_PROJECT_API_KEY: projectApiKey,
        XAI_API_KEY: xaiApiKey,
      },
    );
    console.log(
      JSON.stringify({
        code: "production-device-userspace-installed",
        commitOid: installed.commitOid,
        mode: installed.mode,
        target: options.deviceId,
      }),
    );
  }

  if (options.flashFirmware) {
    await flashLocalFirmware(
      plan.flashArgs,
      {
        ...environment,
        ITERATE_KIT_PROJECT_API_KEY: projectApiKey,
        ITERATE_KIT_WIFI_PASSWORD: configuration.wifi.password,
      },
      packageDirectory,
    );
    console.log(
      JSON.stringify({
        code: "production-device-firmware-flashed",
        currentPort: options.port,
        stableUsbSerial: options.deviceMac,
        target: options.deviceId,
      }),
    );
  }

  const reachabilityDeadline = Date.now() + 60_000;
  while (true) {
    try {
      await executeFile("/sbin/ping", ["-c", "1", "-W", "1000", options.deviceHost]);
      break;
    } catch {
      if (Date.now() >= reachabilityDeadline) {
        throw new Error(
          `${device.name} did not regain LAN reachability within 60 seconds after the flash read.`,
        );
      }
      await delay(1_000);
    }
  }

  console.log(
    JSON.stringify({
      code: "production-device-reachable",
      host: options.deviceHost,
      target: options.deviceId,
      waitingForPcmRegistration: true,
    }),
  );
  await delay(18_000);

  const proofEnvironment = {
    ...environment,
    ITERATE_KIT_PROJECT_API_KEY: projectApiKey,
    ITERATE_KIT_PROJECT_ID: plan.projectId,
  };
  if (options.mode === "tone") {
    if (options.deviceId !== "m5sticks3") {
      throw new Error("The retained deterministic tone proof currently supports only m5sticks3.");
    }
    const result = await proveProductionM5StickS3Tone(
      ["--device-host", options.deviceHost],
      proofEnvironment,
    );
    return { ...result, provenance: plan.provenance };
  }

  const result =
    options.deviceId === "stackchan" ||
    options.deviceId === "home-assistant-voice-preview-edition"
      ? await proveProductionStackChanGrok(plan.grokProofArgs, proofEnvironment, plan.provenance)
      : await proveProductionM5StickS3Grok(plan.grokProofArgs, proofEnvironment, plan.provenance);
  return { ...result, provenance: plan.provenance };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file:"))
) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(productionDeviceProofUsage);
  } else {
    try {
      const result = await proveProductionGrokFromDevice(process.argv.slice(2), process.env);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, () => {
        /*
         * This is a finite proof CLI, not a Cap'n Web daemon. The project RPC
         * client can retain a closing WebSocket handle after all evidence and
         * cleanup have completed; waiting for Node's handle set made a failed
         * unattended run appear hung for minutes. Flush the only result first,
         * then end with the already-decided proof status.
         */
        process.exit(result.passed ? 0 : 1);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`, () => process.exit(1));
    }
  }
}
