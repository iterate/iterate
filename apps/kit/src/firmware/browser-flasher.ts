import type { FirmwareFlashPlan } from "./prepare-flash-plan.ts";

export interface BrowserFlashCallbacks {
  onLog?: (line: string) => void;
  onProgress?: (input: { fileIndex: number; writtenBytes: number; totalBytes: number }) => void;
}

export async function flashFirmwareInBrowser(
  plan: FirmwareFlashPlan,
  callbacks: BrowserFlashCallbacks = {},
) {
  if (!("serial" in navigator)) {
    throw new Error("Web Serial is unavailable. Use Chrome or Edge on desktop.");
  }

  const port = await navigator.serial.requestPort();
  const { ESPLoader, Transport } = await import("esptool-js");
  const transport = new Transport(port, false);
  const loader = new ESPLoader({
    baudrate: 921_600,
    debugLogging: false,
    terminal: {
      clean: () => {},
      write: (value) => callbacks.onLog?.(value),
      writeLine: (value) => callbacks.onLog?.(value),
    },
    transport,
  });

  let operationFailure: unknown;
  try {
    const detectedChip = await loader.main();
    if (detectedChip !== plan.chipFamily) {
      throw new Error(`Connected device is ${detectedChip}; firmware requires ${plan.chipFamily}.`);
    }
    await loader.writeFlash({
      compress: true,
      eraseAll: plan.eraseAll,
      fileArray: plan.parts.map((part) => ({
        address: part.address,
        data: part.data,
      })),
      flashFreq: "keep",
      flashMode: "keep",
      flashSize: "detect",
      reportProgress: (fileIndex, writtenBytes, totalBytes) => {
        callbacks.onProgress?.({ fileIndex, writtenBytes, totalBytes });
      },
    });
    await loader.after("hard_reset");
  } catch (error) {
    operationFailure = error;
  }

  let disconnectFailure: unknown;
  if (port.readable || port.writable) {
    try {
      await transport.disconnect();
    } catch (error) {
      disconnectFailure = error;
    }
  }

  if (operationFailure && disconnectFailure) {
    throw new AggregateError(
      [operationFailure, disconnectFailure],
      "Firmware flashing and serial cleanup both failed.",
    );
  }
  if (operationFailure) throw operationFailure;
  if (disconnectFailure) throw disconnectFailure;
}
