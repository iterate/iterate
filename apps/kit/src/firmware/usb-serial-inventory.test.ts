import { describe, expect, it } from "vitest";
import { resolveEspUsbSerialDevice, waitForEspUsbSerialDevice } from "./usb-serial-inventory.ts";

function inventory(entries: unknown[]) {
  return JSON.stringify(entries);
}

describe("resolveEspUsbSerialDevice", () => {
  it("follows the stable ROM MAC when a hub changes the ephemeral port suffix", () => {
    /*
     * This rig has already swapped StackChan and HAVPE port suffixes after a
     * hub reconnect. A flasher which remembers `/dev/cu.usbmodem11101` can
     * therefore be internally consistent and still erase the wrong board.
     * This test makes the MAC-to-current-port resolution the destructive
     * operation's explicit invariant.
     */
    expect(
      resolveEspUsbSerialDevice(
        inventory([
          {
            device: "/dev/cu.usbmodem11101",
            pid: 0x1001,
            serial: "D8:3B:DA:46:20:34",
            vid: 0x303a,
          },
          {
            device: "/dev/cu.usbmodem2101",
            pid: 0x1001,
            serial: "68:ee:8f:d8:53:20",
            vid: 0x303a,
          },
        ]),
        "68:EE:8F:D8:53:20",
      ),
    ).toEqual({
      port: "/dev/cu.usbmodem2101",
      stableUsbSerial: "68:EE:8F:D8:53:20",
    });
  });

  it("refuses duplicate serial observations instead of choosing one arbitrarily", () => {
    /*
     * A duplicate generally means stale OS enumeration or a broken USB
     * identity. Choosing the first match makes a dangerous condition look
     * deterministic; refusing the write keeps recovery bounded and visible.
     */
    const duplicate = {
      device: "/dev/cu.usbmodem11101",
      pid: 0x1001,
      serial: "70:04:1D:D5:45:88",
      vid: 0x303a,
    };
    expect(() =>
      resolveEspUsbSerialDevice(
        inventory([duplicate, { ...duplicate, device: "/dev/cu.usbmodem11301" }]),
        duplicate.serial,
      ),
    ).toThrow(/exactly one/u);
  });

  it("requires the native Espressif USB interface in addition to the serial", () => {
    /*
     * USB serial strings are not globally trustworthy. The VID/PID check is a
     * second, independent guard against a non-ESP device reusing a string that
     * happens to resemble the recorded ROM MAC.
     */
    expect(() =>
      resolveEspUsbSerialDevice(
        inventory([
          {
            device: "/dev/cu.usbmodem11301",
            pid: 0x1234,
            serial: "70:04:1D:D5:45:88",
            vid: 0x5678,
          },
        ]),
        "70:04:1D:D5:45:88",
      ),
    ).toThrow(/VID:PID/u);
  });
});

describe("waitForEspUsbSerialDevice", () => {
  it("re-resolves the stable identity after native USB re-enumeration", async () => {
    /*
     * Every esptool reset briefly removes `/dev/cu.usbmodem*`. Retrying the
     * remembered path raced that interval in the physical HAVPE AEC harness.
     * Each destructive transaction must instead wait for the exact ROM MAC to
     * reappear and use whichever suffix macOS assigns on that observation.
     */
    let attempts = 0;
    await expect(
      waitForEspUsbSerialDevice(
        {
          pythonExecutable: "python3",
          stableUsbSerial: "D8:3B:DA:46:20:34",
          timeoutMs: 10,
        },
        {
          delay: async () => {},
          discover: async () => {
            attempts += 1;
            if (attempts < 3) throw new Error("USB node absent during reset");
            return {
              port: "/dev/cu.usbmodem99101",
              stableUsbSerial: "D8:3B:DA:46:20:34",
            };
          },
          now: () => attempts,
        },
      ),
    ).resolves.toEqual({
      port: "/dev/cu.usbmodem99101",
      stableUsbSerial: "D8:3B:DA:46:20:34",
    });
    expect(attempts).toBe(3);
  });
});
