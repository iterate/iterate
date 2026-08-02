import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { findFirmwareDevice } from "../src/firmware/catalog.ts";
import { decodeDeviceConfiguration } from "../src/firmware/config-image.ts";
import { readFlashRegionWithEsptool } from "../src/firmware/esptool-cli.ts";
import { readLocalEspIdfNamedPartition } from "../src/firmware/local-idf-build.ts";

interface UpgradeInspectionOptions {
  buildDirectory: string;
  deviceId: string;
  port: string;
  workerHost?: string;
}

interface RedactedHeaderShape {
  name: string;
  valueBytes: number;
}

/**
 * Measures the real HTTP/1.1 WebSocket upgrade envelope without ever printing
 * the retained project credential.
 *
 * ESP-IDF's stock WebSocket transport parses the entire response through one
 * fixed CONFIG_WS_BUFFER_SIZE buffer. When Cloudflare or userspace adds a
 * header, the resulting error otherwise says only "Header size exceeded" and
 * tempts us to increase RAM by guesswork. This host-side probe uses the exact
 * device identity and bearer but reports only byte counts and header names, so
 * the firmware budget can retain an explicit measured margin.
 *
 * Reading the Iterate config partition resets the selected ESP. That is why
 * the caller must provide both the current serial port and catalog device id;
 * this script is intentionally not an ambient USB scanner.
 */
export async function inspectDevicePcmUpgrade(options: UpgradeInspectionOptions): Promise<{
  configuredPcmOrigin: string;
  requestHeaderBytes: number;
  responseHeaderBytes: number;
  responseHeaders: RedactedHeaderShape[];
  statusCode: number;
}> {
  const device = findFirmwareDevice(options.deviceId);
  if (!device || device.installMethod.kind !== "esp-serial") {
    throw new Error(`${options.deviceId} is not an ESP serial target.`);
  }
  const configurationRegion = await readLocalEspIdfNamedPartition({
    buildDirectory: options.buildDirectory,
    device,
    partitionLabel: "iterate_kit",
  });
  const configuration = decodeDeviceConfiguration(
    await readFlashRegionWithEsptool({
      chipFamily: device.installMethod.chipFamily,
      port: options.port,
      pythonExecutable: process.env.ITERATE_KIT_PYTHON?.trim() || undefined,
      region: configurationRegion,
    }),
  );
  const audioMode = options.deviceId === "m5sticks3" ? "push-to-talk" : "full-duplex-aec";
  const configuredPcmOrigin = new URL(configuration.iterate.pcmBaseUrl).origin;
  if (
    options.workerHost !== undefined &&
    new URL(`https://${options.workerHost}`).origin !== configuredPcmOrigin
  ) {
    throw new Error(
      `The supplied worker host does not match the device's retained PCM origin ${configuredPcmOrigin}.`,
    );
  }
  const requestHeaders = {
    Authorization: `Bearer ${configuration.iterate.projectApiKey}`,
    "X-Iterate-Kit-Audio-Mode": audioMode,
    "X-Iterate-Kit-Device-ID": options.deviceId,
    "X-Iterate-Project-ID": configuration.iterate.projectId,
  };

  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${configuredPcmOrigin.replace(/^http/u, "ws")}/pcm`,
      "iterate.kit.pcm.v1",
      { headers: requestHeaders },
    );
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("Timed out waiting for the PCM WebSocket upgrade."));
    }, 15_000);
    const finish = (response: import("node:http").IncomingMessage) => {
      clearTimeout(timeout);
      const statusLine = `HTTP/1.1 ${response.statusCode ?? 0} ${response.statusMessage ?? ""}\r\n`;
      const responseHeaders: RedactedHeaderShape[] = [];
      let responseHeaderBytes = Buffer.byteLength(statusLine) + 2;
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const name = response.rawHeaders[index] ?? "";
        const value = response.rawHeaders[index + 1] ?? "";
        responseHeaderBytes += Buffer.byteLength(`${name}: ${value}\r\n`);
        responseHeaders.push({ name: name.toLowerCase(), valueBytes: Buffer.byteLength(value) });
      }
      /*
       * This is a header-budget probe, not a second media peer. Terminate as
       * soon as the server proves the upgrade so no provider/downlink queue is
       * allowed to form while the physical device is idle.
       */
      socket.terminate();
      resolve({
        configuredPcmOrigin,
        requestHeaderBytes: Buffer.byteLength(
          Object.entries(requestHeaders)
            .map(([name, value]) => `${name}: ${value}\r\n`)
            .join(""),
        ),
        responseHeaderBytes,
        responseHeaders,
        statusCode: response.statusCode ?? 0,
      });
    };
    socket.once("upgrade", finish);
    socket.once("unexpected-response", (_request, response) => finish(response));
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function parseArgs(args: readonly string[]): UpgradeInspectionOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1]?.trim();
    if (!flag?.startsWith("--") || !value) throw new Error(`Invalid option ${flag ?? ""}.`);
    values.set(flag, value);
  }
  const required = (flag: string) => {
    const value = values.get(flag);
    if (!value) throw new Error(`${flag} is required.`);
    return value;
  };
  return {
    buildDirectory: required("--build-directory"),
    deviceId: required("--device-id"),
    port: required("--port"),
    workerHost: values.get("--worker-host"),
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file:"))
) {
  inspectDevicePcmUpgrade(parseArgs(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
