import { describe, expect, it } from "vitest";
import { parseWifiReprovisionOptions } from "../../scripts/reprovision-device-wifi.ts";

describe("parseWifiReprovisionOptions", () => {
  it("accepts the argument separator retained by the pnpm script runner", () => {
    /*
     * The first physical invocation failed before touching flash because pnpm
     * retained `--` in process.argv. Keeping this exact production command
     * shape under test prevents a safe reprovision helper from becoming an
     * untested one-off that only works when invoked through tsx directly.
     */
    const options = parseWifiReprovisionOptions([
      "--",
      "--device",
      "m5sticks3",
      "--stable-usb-serial",
      "70:04:1D:D5:45:88",
      "--wifi-ssid",
      "replacement network",
      "--build-directory",
      "/tmp/m5sticks3-build",
      "--python-executable",
      "/tmp/idf-python",
    ]);

    expect(options).toEqual({
      buildDirectory: "/tmp/m5sticks3-build",
      deviceId: "m5sticks3",
      pythonExecutable: "/tmp/idf-python",
      stableUsbSerial: "70:04:1D:D5:45:88",
      wifiSsid: "replacement network",
    });
  });
});
