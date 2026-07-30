import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flashFirmwareInBrowser } from "./browser-flasher.ts";
import type { FirmwareFlashPlan } from "./prepare-flash-plan.ts";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  disconnect: vi.fn(),
  main: vi.fn(),
  requestPort: vi.fn(),
  writeFlash: vi.fn(),
}));

vi.mock("esptool-js", () => ({
  ESPLoader: class {
    main = mocks.main;
    writeFlash = mocks.writeFlash;
    after = mocks.after;
  },
  Transport: class {
    disconnect = mocks.disconnect;
  },
}));

const plan: FirmwareFlashPlan = {
  chipFamily: "ESP32-S3",
  eraseAll: true,
  parts: [
    { address: 0x1000, data: Uint8Array.of(1, 2), label: "bootloader.bin" },
    { address: 0x9000, data: Uint8Array.of(3, 4), label: "iterate-kit/v1 configuration" },
  ],
};

describe("flashFirmwareInBrowser", () => {
  beforeEach(() => {
    const port = { readable: {}, writable: {} };
    mocks.requestPort.mockResolvedValue(port);
    mocks.main.mockResolvedValue("ESP32-S3");
    mocks.writeFlash.mockResolvedValue(undefined);
    mocks.after.mockResolvedValue(undefined);
    mocks.disconnect.mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { serial: { requestPort: mocks.requestPort } });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("flashes the shared byte plan, resets, and disconnects", async () => {
    const onProgress = vi.fn();

    await flashFirmwareInBrowser(plan, { onProgress });

    expect(mocks.requestPort).toHaveBeenCalledOnce();
    expect(mocks.writeFlash).toHaveBeenCalledWith(
      expect.objectContaining({
        compress: true,
        eraseAll: true,
        fileArray: [
          { address: 0x1000, data: Uint8Array.of(1, 2) },
          { address: 0x9000, data: Uint8Array.of(3, 4) },
        ],
        flashFreq: "keep",
        flashMode: "keep",
        flashSize: "detect",
      }),
    );
    expect(mocks.after).toHaveBeenCalledWith("hard_reset");
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it("refuses the wrong chip before writing but still disconnects", async () => {
    mocks.main.mockResolvedValue("ESP32-C3");

    await expect(flashFirmwareInBrowser(plan)).rejects.toThrow(
      "Connected device is ESP32-C3; firmware requires ESP32-S3",
    );
    expect(mocks.writeFlash).not.toHaveBeenCalled();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it("preserves both a flash failure and a cleanup failure", async () => {
    mocks.writeFlash.mockRejectedValue(new Error("write failed"));
    mocks.disconnect.mockRejectedValue(new Error("disconnect failed"));

    await expect(flashFirmwareInBrowser(plan)).rejects.toMatchObject({
      message: "Firmware flashing and serial cleanup both failed.",
      errors: [expect.objectContaining({ message: "write failed" }), expect.objectContaining({ message: "disconnect failed" })],
    });
  });
});
