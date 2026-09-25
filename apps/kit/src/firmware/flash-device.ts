import type { EwtConsole } from "esp-web-tools/dist/components/ewt-console.js";
import type { Manifest } from "esp-web-tools/dist/const.js";
import type { FirmwareDevice } from "./catalog.ts";
import type { DeviceConfiguration } from "./config-image.ts";
import { prepareInstall, type FirmwareManifest } from "./prepare-manifest.ts";

/** How far a flash has got, as esp-web-tools reports it on the way. */
export type FlashProgress =
  | { state: "initializing" | "preparing" | "erasing"; message: string }
  | { state: "writing"; message: string; details: { percentage: number } };

/** esp-web-tools' `FlashState`, spelled out: its `state` is a const enum, which this build (with
 *  `isolatedModules`) can't read. */
type FlashState =
  | FlashProgress
  | { state: "finished"; message: string }
  | {
      state: "error";
      message: string;
      chipFamily?: string;
      details: { error: string; details: unknown };
    };

/** Asks for the board's serial port (Chrome's chooser; the wizard says which entry to pick). */
async function choosePort() {
  return navigator.serial.requestPort().catch((error: unknown) => {
    // the person closed the chooser, or it listed nothing to pick
    if (error instanceof DOMException && error.name === "NotFoundError")
      throw new Error("No port was picked. Plug the board in with a data cable, then try again.");
    throw error;
  });
}

/**
 * Asks for the board's serial port, then writes the release and this install's configuration with
 * esp-web-tools' `flash`: the step its install dialog runs, without the dialog, so Kit shows the
 * progress, the errors and what to do next itself. Resolves with the port once the board has
 * restarted into the new firmware, so its logs can be read from the same port. Rejects with a
 * message that says what to do; the raw error is its `cause`.
 */
export async function flashDevice(input: {
  manifest: FirmwareManifest;
  device: FirmwareDevice;
  configuration: DeviceConfiguration;
  erase: boolean;
  onProgress: (progress: FlashProgress) => void;
}) {
  const port = await choosePort();
  const { flash } = await import("esp-web-tools/dist/flash.js");
  using install = prepareInstall(input.manifest, input.device, input.configuration);
  let failure: Error | undefined;
  try {
    await flash(
      (event) => {
        const state = event as unknown as FlashState;
        if (state.state === "error") failure = readableFailure(state, input.device);
        else if (state.state !== "finished") input.onProgress(state);
      },
      port,
      // only resolves relative part paths, and every path is absolute (prepare-manifest.ts)
      window.location.href,
      install.manifest as Manifest,
      input.erase,
    );
  } catch (error) {
    // After an error event, `flash` resets the board and closes the port, which can throw too: the
    // event says what went wrong. Without one, this is an erase or a reset that failed.
    failure ||= new Error(
      `Flashing stopped (${messageOf(error)}). Unplug the board, plug it back in and try again.`,
      { cause: error },
    );
  }
  if (failure) {
    console.error("kit.flash_failed", failure, failure.cause);
    throw failure;
  }
  return port;
}

/**
 * Opens a board's serial port to read its logs, what esp-web-tools' "Logs & Console" did: the port
 * it was just flashed through (`flash` closed it), or one the person picks. Returns esp-web-tools'
 * console element for it, which starts reading once it's on the page (components/device-logs.tsx);
 * `closeDeviceLogs` stops it.
 */
export async function openDeviceLogs(port: SerialPort | undefined) {
  const chosen = port || (await choosePort());
  await import("esp-web-tools/dist/components/ewt-console.js");
  await chosen.open({ baudRate: 115200, bufferSize: 8192 }).catch((error: unknown) => {
    throw portProblem(error);
  });
  const logs = document.createElement("ewt-console");
  logs.port = chosen;
  logs.logger = console;
  logs.allowInput = false;
  logs.style.height = "100%";
  return logs;
}

/** Stops reading and lets go of the port, so flashing (or another tab) can open it next. */
export async function closeDeviceLogs(logs: EwtConsole) {
  await logs.disconnect();
  await logs.port.close();
}

function readableFailure(state: Extract<FlashState, { state: "error" }>, device: FirmwareDevice) {
  const cause = state.details.details;
  const message = messageOf(cause);
  switch (state.details.error) {
    case "failed_initialize":
      return portBusy(message)
        ? portProblem(cause)
        : new Error(
            `Couldn't talk to the board (${message}). Unplug it, plug it back in and try again. If it still fails, hold its BOOT button while you plug it in.`,
            { cause },
          );
    case "not_supported":
      return new Error(
        `That port is a ${state.chipFamily} board, and this firmware is for a ${device.name}. Try again and pick the other port.`,
        { cause },
      );
    case "failed_firmware_download":
      return new Error(
        `Couldn't download the firmware (${message}). Check your connection and try again.`,
        { cause },
      );
    default:
      return new Error(
        `Writing stopped part-way (${message}). Keep the board plugged in and try again: a half-written board flashes fine.`,
        { cause },
      );
  }
}

/** "The port is already open." (this page holds it) or "Failed to open serial port." (another page
 *  or program does): what the dogfood hit after an earlier tab's flash. */
function portBusy(message: string) {
  return /already open|failed to open/i.test(message);
}

function portProblem(error: unknown) {
  const message = messageOf(error);
  return portBusy(message)
    ? new Error(
        "Something else is using the board's port: another Kit tab, a serial monitor or a terminal. Close it, unplug the board, plug it back in and try again.",
        { cause: error },
      )
    : new Error(
        `Couldn't open the board's port (${message}). Unplug it, plug it back in and try again.`,
        { cause: error },
      );
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
