# Connected Iterate Kit device inventory

Recorded on 2026-07-30 and last re-enumerated non-disruptively on 2026-08-02.
This is both the current four-board inventory and the safety procedure for
finding the boards again after the shared USB hub is unplugged, moved, or
enumerated in a different order.

## Selection invariant

Never select a flash target from `/dev/cu.usbmodemNNN` alone. That suffix is
assigned during USB enumeration and can move after any reconnect. All four
ESP32-S3 boards currently present the same Espressif USB Serial/JTAG
`VID:PID` (`303a:1001`), so VID/PID is not enough either.

The native USB Serial/JTAG serial string is the ESP32-S3 ROM MAC address and
is the stable selection authority. Resolve the current port from that serial
immediately before every probe, monitor, erase, or flash operation, and refuse
the operation unless exactly one matching port exists. USB `LOCATION` is a
useful physical-hub hint, not identity.

The non-resetting inventory command is:

```sh
source /Users/jonastemplestein/esp/esp-idf/export.sh >/dev/null 2>&1
python -m serial.tools.list_ports -v
```

Listing ports is non-disruptive; opening the M5StickS3 native USB serial port
is not. On 2026-07-31, opening its port at 115200 reset the running firmware
with ROM reason `USB_UART_CHIP_RESET` even after the host explicitly disabled
both DTR and RTS. Treat every serial monitor/open as a device reset and never
use it to inspect a live outage: it destroys the pre-reset transport state that
the diagnosis needs. Resolving the port by USB metadata remains safe.

`system_profiler SPUSBDataType -json` can corroborate serial and location
information on macOS, but `serial.tools.list_ports` is preferred because it
also reports the `/dev/cu.*` path needed by ESP-IDF tools.

## Connected boards

| Board                                  | Stable USB serial / ROM MAC | Observed port           | Observed location | Current-firmware evidence                                                          |
| -------------------------------------- | --------------------------- | ----------------------- | ----------------- | ---------------------------------------------------------------------------------- |
| StackChan / M5Stack CoreS3             | `68:EE:8F:D8:53:20`         | `/dev/cu.usbmodem2101`  | `2-1`             | Separately connected; Iterate voice/AEC/avatar firmware, face physically confirmed |
| M5StickS3                              | `70:04:1D:D5:45:88`         | `/dev/cu.usbmodem11301` | `1-1.3`           | Iterate voice firmware and first physical Iterate Kit firmware target              |
| Waveshare ESP32-S3 touch-screen device | `1C:DB:D4:7A:16:C8`         | `/dev/cu.usbmodem11201` | `1-1.2`           | Iterate voice firmware                                                             |
| Home Assistant Voice Preview Edition   | `D8:3B:DA:46:20:34`         | `/dev/cu.usbmodem11101` | `1-1.1`           | Iterate voice/AEC firmware                                                         |

The ports and locations in this table are observations from the most recent
enumeration, not arguments to save in a script. The 2026-08-01 hub reconnect
swapped StackChan and Home Assistant's old suffixes/locations while leaving
their serials unchanged. On 2026-08-02, moving StackChan off the shared hub
changed it again to location `2-1` and suffix `2101`, with the same serial.
Both are direct evidence for making the stable serial the persistent key a CLI
or physical test manifest stores.

`/dev/cu.usbserial-0001` is an unrelated CP2102/CeilSense device and is not an
Iterate Kit flash target.

## Read-only identification evidence

The two previously ambiguous boards were identified with ROM and flash reads.
Both report ESP32-S3 revision v0.2, 8 MiB embedded PSRAM, 16 MiB flash, and
native USB Serial/JTAG. The Waveshare board has a factory app at `0x100000`
and the Voice Preview Edition has its app at `0x10000`; their app descriptors
are recorded in the table above.

These reads did not alter flash, but entering the ROM loader resets and then
reboots a board. Therefore even a nominally read-only ESP tool is not
non-disruptive. Do not probe a board another agent owns merely to rediscover
its port: the USB serial mapping already provides that answer.

## Flash guardrails

1. Enumerate immediately before the operation.
2. Resolve the requested board by exact, case-insensitive stable serial.
3. Require exactly one match and verify its `VID:PID` is `303a:1001`.
4. Print the logical board, stable serial, and freshly resolved port.
5. Refuse a mismatched firmware/board pair before invoking `esptool`.
6. Do not open, reset, monitor, or flash StackChan while another agent owns it.
7. After flashing, re-enumerate by the same serial and capture boot evidence;
   do not assume the old port survived the reset.

The shared TypeScript flashing core should implement these checks once for the
CLI and `k.iterate.com` where the host API exposes the serial. Web Serial may
withhold a stable serial for privacy reasons; in that case the browser must
make board choice and post-flash hardware identity explicit rather than
pretending VID/PID distinguishes these four boards.
