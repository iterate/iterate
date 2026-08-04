import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { findFirmwareDevice } from "../src/firmware/catalog.ts";
import {
  decodeDeviceConfiguration,
  encodeDeviceConfiguration,
} from "../src/firmware/config-image.ts";
import {
  flashFirmwareWithEsptool,
  readFlashRegionWithEsptool,
} from "../src/firmware/esptool-cli.ts";
import { readLocalEspIdfNamedPartition } from "../src/firmware/local-idf-build.ts";
import { discoverEspUsbSerialDevice } from "../src/firmware/usb-serial-inventory.ts";
import {
  assertWifiReprovisionReadback,
  withReprovisionedWifi,
} from "../src/firmware/wifi-reprovision.ts";

interface WifiReprovisionOptions {
  buildDirectory: string;
  deviceId: string;
  pythonExecutable: string;
  stableUsbSerial: string;
  wifiSsid: string;
}

const usage = `Usage:
  pnpm firmware:wifi -- --device <catalog-id> --stable-usb-serial <ROM-MAC> \\
    --wifi-ssid <name> [--build-directory <path>]

The new password is read from ITERATE_KIT_WIFI_PASSWORD or, when absent,
prompted on stdin. The command reads the existing iterate_kit partition,
changes only Wi-Fi, writes only that partition, and verifies a fresh readback.`;

export async function reprovisionDeviceWifi(options: WifiReprovisionOptions, wifiPassword: string) {
  const device = findFirmwareDevice(options.deviceId);
  if (!device || device.installMethod.kind !== "esp-serial") {
    throw new Error(`${options.deviceId} is not an ESP serial firmware target.`);
  }
  const partition = await readLocalEspIdfNamedPartition({
    buildDirectory: options.buildDirectory,
    device,
    partitionLabel: "iterate_kit",
  });

  const beforeRead = await discoverEspUsbSerialDevice(options);
  console.log(
    `wifi_reprovision_read device=${device.id} stable_usb_serial=${beforeRead.stableUsbSerial} ` +
      `port=${beforeRead.port}`,
  );
  const beforeBytes = await readFlashRegionWithEsptool({
    chipFamily: device.installMethod.chipFamily,
    port: beforeRead.port,
    pythonExecutable: options.pythonExecutable,
    region: partition,
  });
  const before = decodeDeviceConfiguration(beforeBytes);
  const expected = withReprovisionedWifi(before, {
    password: wifiPassword,
    ssid: options.wifiSsid,
  });
  const encoded = encodeDeviceConfiguration(expected, partition.size);

  const beforeWrite = await discoverEspUsbSerialDevice(options);
  console.log(
    `wifi_reprovision_write device=${device.id} stable_usb_serial=${beforeWrite.stableUsbSerial} ` +
      `port=${beforeWrite.port} partition=0x${partition.offset.toString(16)} bytes=${partition.size}`,
  );
  await flashFirmwareWithEsptool(
    {
      chipFamily: device.installMethod.chipFamily,
      eraseAll: false,
      parts: [
        {
          address: partition.offset,
          data: encoded,
          label: "iterate-kit/v1 Wi-Fi-only reprovision",
        },
      ],
    },
    { port: beforeWrite.port, pythonExecutable: options.pythonExecutable },
  );

  const beforeVerify = await discoverEspUsbSerialDevice(options);
  const actual = decodeDeviceConfiguration(
    await readFlashRegionWithEsptool({
      chipFamily: device.installMethod.chipFamily,
      port: beforeVerify.port,
      pythonExecutable: options.pythonExecutable,
      region: partition,
    }),
  );
  assertWifiReprovisionReadback(before, expected, actual);
  const summary = {
    device: device.id,
    pcmOrigin: actual.iterate.pcmBaseUrl,
    port: beforeVerify.port,
    projectId: actual.iterate.projectId,
    projectIdentityPreserved: true,
    stableUsbSerial: beforeVerify.stableUsbSerial,
    wifiSsid: actual.wifi.ssid,
  };
  console.log(`wifi_reprovision_verified ${JSON.stringify(summary)}`);
  return summary;
}

export function parseWifiReprovisionOptions(args: readonly string[]): WifiReprovisionOptions {
  /* pnpm preserves the conventional separator in process.argv for this script. */
  const options = args[0] === "--" ? args.slice(1) : args;
  const values = new Map<string, string>();
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Option ${option ?? ""} requires a value.`);
    }
    if (values.has(option)) throw new Error(`Option ${option} was provided more than once.`);
    values.set(option, value);
  }
  const deviceId = values.get("--device");
  const stableUsbSerial = values.get("--stable-usb-serial");
  const wifiSsid = values.get("--wifi-ssid");
  const unknown = [...values.keys()].filter(
    (option) =>
      ![
        "--build-directory",
        "--device",
        "--python-executable",
        "--stable-usb-serial",
        "--wifi-ssid",
      ].includes(option),
  );
  if (unknown.length > 0) throw new Error(`Unknown option ${unknown[0]}.`);
  if (!deviceId || !stableUsbSerial || !wifiSsid) {
    throw new Error("--device, --stable-usb-serial, and --wifi-ssid are required.");
  }
  const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
  return {
    buildDirectory:
      values.get("--build-directory") ??
      fileURLToPath(new URL(`../.build/${deviceId}/`, new URL(packageDirectory, "file:"))),
    deviceId,
    pythonExecutable:
      values.get("--python-executable") ?? process.env.ITERATE_KIT_PYTHON ?? "python3",
    stableUsbSerial,
    wifiSsid,
  };
}

async function readWifiPassword() {
  const fromEnvironment = process.env.ITERATE_KIT_WIFI_PASSWORD;
  if (fromEnvironment !== undefined) return fromEnvironment;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await input.question("Wi-Fi password: ");
  } finally {
    input.close();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file:"))
) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage);
  } else {
    reprovisionDeviceWifi(
      parseWifiReprovisionOptions(process.argv.slice(2)),
      await readWifiPassword(),
    ).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
