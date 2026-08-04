import { resolve } from "node:path";
import type { DeviceConfiguration } from "../firmware/config-image.ts";
import { DEFAULT_DEVICE_ID, findFirmwareDevice } from "../firmware/catalog.ts";
import {
  productionSpokenCountFlag,
  productionSpokenCountScenarioFromFlag,
  type ProductionGrokProofScenario,
} from "./production-grok-cli-options.ts";
import { kitDeviceCapabilitySegment } from "../userspace/config-worker/device-id.ts";
import { kitDeviceEventStreamPath } from "../userspace/config-worker/provider-event-stream.ts";

const legacyStickDefaults = {
  deviceHost: "192.168.0.21",
} as const;
const stableUsbSerialByDeviceId: Readonly<Record<string, string>> = {
  "home-assistant-voice-preview-edition": "D8:3B:DA:46:20:34",
  m5sticks3: "70:04:1D:D5:45:88",
  stackchan: "68:EE:8F:D8:53:20",
};
const defaultProjectSlug = "kit-stick-vertical-proof";
const defaultWorkerHost = "kit--kit-stick-vertical-proof.iterate.app";

export type ProductionDeviceProofMode = "grok" | "tone";

export interface ProductionDeviceProofCliOptions {
  buildDirectory: string;
  deviceHost: string;
  deviceId: string;
  deviceMac: string;
  flashFirmware: boolean;
  installUserspace: boolean;
  mode: ProductionDeviceProofMode;
  outputDirectory: string;
  port: string;
  projectId?: string;
  projectSlug: string;
  scenario: ProductionGrokProofScenario;
  turns: number;
  workerHost: string;
}

export interface ProductionDeviceProofProvenance {
  device: {
    buildDirectory: string;
    currentPort: string;
    host: string;
    id: string;
    name: string;
    stableUsbSerial: string;
  };
  project: {
    baseUrl: string;
    id: string;
    slug: string;
    workerHost: string;
  };
  routes: {
    capabilityMountPath: readonly ["kit", string];
    pcmUrl: string;
    providerEventStreamPath: `/devices/${string}`;
  };
  schemaVersion: 1;
}

interface ParsedValues {
  buildDirectory?: string;
  deviceHost?: string;
  deviceId?: string;
  deviceMac?: string;
  mode?: string;
  outputDirectory?: string;
  port?: string;
  projectId?: string;
  projectSlug?: string;
  turns?: string;
  workerHost?: string;
}

/**
 * Parses the unattended physical proof independently of secret provisioning
 * values. Every board must name its current port so a hub re-enumeration
 * cannot silently redirect a destructive read/flash. The Stick retains only
 * its non-destructive LAN default; its former serial default physically moved
 * to a denylisted neighbouring board while this harness was running.
 */
export function parseProductionDeviceProofCliOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  packageDirectory: string,
): ProductionDeviceProofCliOptions {
  const values: ParsedValues = {};
  let flashFirmware = environment.ITERATE_KIT_FLASH_FIRMWARE === "1";
  let installUserspace = environment.ITERATE_KIT_INSTALL_USERSPACE === "1";
  let scenario: ProductionGrokProofScenario = "conversation";

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === "--flash-firmware") {
      flashFirmware = true;
      continue;
    }
    if (option === "--install-userspace") {
      installUserspace = true;
      continue;
    }
    const spokenCountScenario = productionSpokenCountScenarioFromFlag(option);
    if (spokenCountScenario) {
      if (scenario !== "conversation") {
        throw new Error("Only one spoken-count scenario may be selected.");
      }
      scenario = spokenCountScenario;
      continue;
    }
    const value = args[index + 1]?.trim();
    if (!value || value.startsWith("--")) {
      throw new Error(`Option ${option} requires a value.`);
    }
    index += 1;
    switch (option) {
      case "--build-directory":
        values.buildDirectory = value;
        break;
      case "--device-host":
        values.deviceHost = value;
        break;
      case "--device-id":
        values.deviceId = value;
        break;
      case "--device-mac":
        values.deviceMac = value;
        break;
      case "--mode":
        values.mode = value;
        break;
      case "--output-directory":
        values.outputDirectory = value;
        break;
      case "--port":
        values.port = value;
        break;
      case "--project-id":
        values.projectId = value;
        break;
      case "--project-slug":
        values.projectSlug = value;
        break;
      case "--turns":
        values.turns = value;
        break;
      case "--worker-host":
        values.workerHost = value;
        break;
      default:
        throw new Error(`Unknown option ${option}.`);
    }
  }

  const deviceId =
    values.deviceId ?? environment.ITERATE_KIT_DEVICE_ID?.trim() ?? DEFAULT_DEVICE_ID;
  const device = findFirmwareDevice(deviceId);
  if (!device) {
    throw new Error(`Device ${JSON.stringify(deviceId)} is not in the firmware catalog.`);
  }
  if (device.installMethod.kind !== "esp-serial") {
    throw new Error(`${device.name} cannot run the ESP serial physical proof.`);
  }

  const legacyStick = deviceId === DEFAULT_DEVICE_ID;
  const port = values.port ?? environment.ITERATE_KIT_PORT?.trim();
  const deviceHost =
    values.deviceHost ??
    environment.ITERATE_KIT_DEVICE_HOST?.trim() ??
    (legacyStick ? legacyStickDefaults.deviceHost : undefined);
  const rawDeviceMac =
    values.deviceMac ??
    environment.ITERATE_KIT_DEVICE_MAC?.trim() ??
    stableUsbSerialByDeviceId[deviceId];
  const missing: string[] = [];
  if (!port) missing.push("--port or ITERATE_KIT_PORT");
  if (!deviceHost) missing.push("--device-host or ITERATE_KIT_DEVICE_HOST");
  if (!rawDeviceMac) missing.push("--device-mac or ITERATE_KIT_DEVICE_MAC");
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(", ")} for ${deviceId}.`);
  }
  const requiredPort = port!;
  const requiredDeviceHost = deviceHost!;
  const deviceMac = rawDeviceMac!.toUpperCase();
  if (!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/u.test(deviceMac)) {
    throw new Error("--device-mac must be a six-byte colon-delimited MAC address.");
  }
  if (!requiredPort.startsWith("/dev/cu.") || requiredPort.includes("\0")) {
    throw new Error("--port must name the current macOS /dev/cu.* device.");
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(requiredDeviceHost)) {
    throw new Error("--device-host must be an IP address or DNS hostname without a scheme.");
  }

  const workerHost =
    values.workerHost ?? environment.ITERATE_KIT_WORKER_HOST?.trim() ?? defaultWorkerHost;
  const workerUrl = new URL(`https://${workerHost}`);
  if (workerUrl.hostname !== workerHost || workerUrl.pathname !== "/") {
    throw new Error("--worker-host must be one DNS hostname without a scheme or path.");
  }
  const projectId = values.projectId ?? (environment.ITERATE_KIT_PROJECT_ID?.trim() || undefined);
  if (projectId && !/^prj_[A-Za-z0-9_-]+$/u.test(projectId)) {
    throw new Error("--project-id must be a prj_ project ID.");
  }
  const mode = values.mode ?? environment.ITERATE_KIT_USERSPACE_MODE?.trim() ?? "grok";
  if (mode !== "grok" && mode !== "tone") {
    throw new Error("--mode must be either grok or tone.");
  }
  const turns = Number(values.turns ?? environment.ITERATE_KIT_VOICE_TURNS?.trim() ?? "1");
  if (!Number.isSafeInteger(turns) || turns < 1 || turns > 20) {
    throw new Error("--turns must be an integer from 1 through 20.");
  }

  return {
    buildDirectory: resolve(
      packageDirectory,
      values.buildDirectory ?? `firmware/targets/${deviceId}/build`,
    ),
    deviceHost: requiredDeviceHost,
    deviceId,
    deviceMac,
    flashFirmware,
    installUserspace,
    mode,
    outputDirectory: resolve(
      packageDirectory,
      values.outputDirectory ?? `evidence/${deviceId}-production-grok-from-device`,
    ),
    port: requiredPort,
    projectId,
    projectSlug:
      values.projectSlug ?? environment.ITERATE_KIT_PROJECT_SLUG?.trim() ?? defaultProjectSlug,
    scenario,
    turns,
    workerHost,
  };
}

export interface ProductionDeviceProofPlan {
  flashArgs: string[];
  grokProofArgs: string[];
  projectId: string;
  provenance: ProductionDeviceProofProvenance;
}

/** Builds the complete secret-free route consumed by the side-effecting CLI. */
export function buildProductionDeviceProofPlan(
  options: ProductionDeviceProofCliOptions,
  configuration: DeviceConfiguration,
): ProductionDeviceProofPlan {
  const device = findFirmwareDevice(options.deviceId);
  if (!device || device.installMethod.kind !== "esp-serial") {
    throw new Error(`Device ${JSON.stringify(options.deviceId)} is not an ESP catalog target.`);
  }
  const projectId = options.projectId ?? configuration.iterate.projectId;
  const pcmOrigin = new URL(`https://${options.workerHost}`).origin;
  const grokProofArgs = [
    "--device-id",
    options.deviceId,
    "--device-host",
    options.deviceHost,
    "--worker-host",
    options.workerHost,
    "--project-id",
    projectId,
    "--project-slug",
    options.projectSlug,
    "--output-directory",
    options.outputDirectory,
    "--remote-ptt",
  ];
  if (options.turns > 1) grokProofArgs.push("--turns", String(options.turns));
  const spokenCountFlag = productionSpokenCountFlag(options.scenario);
  if (spokenCountFlag) grokProofArgs.push(spokenCountFlag);
  return {
    flashArgs: [
      "--device",
      options.deviceId,
      "--port",
      options.port,
      "--wifi-ssid",
      configuration.wifi.ssid,
      "--project-id",
      projectId,
      "--base-url",
      configuration.iterate.baseUrl,
      "--pcm-base-url",
      pcmOrigin,
      "--build-directory",
      options.buildDirectory,
    ],
    grokProofArgs,
    projectId,
    provenance: {
      device: {
        buildDirectory: options.buildDirectory,
        currentPort: options.port,
        host: options.deviceHost,
        id: options.deviceId,
        name: device.name,
        stableUsbSerial: options.deviceMac,
      },
      project: {
        baseUrl: configuration.iterate.baseUrl,
        id: projectId,
        slug: options.projectSlug,
        workerHost: options.workerHost,
      },
      routes: {
        capabilityMountPath: ["kit", kitDeviceCapabilitySegment(options.deviceId)],
        pcmUrl: `${pcmOrigin}/pcm`,
        providerEventStreamPath: kitDeviceEventStreamPath(options.deviceId),
      },
      schemaVersion: 1,
    },
  };
}
