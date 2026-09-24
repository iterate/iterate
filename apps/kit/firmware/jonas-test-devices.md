# Jonas's test devices

Identified on 2026-09-21. Use the ROM MAC / USB serial number as identity;
`/dev/cu.usbmodem*` paths can change after reconnecting a device.

| Device                                       | ROM MAC / USB serial | Evidence                                                                                                 |
| -------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| Home Assistant Voice Preview Edition (HAVPE) | `D8:3B:DA:46:20:34`  | Serial boot identifies `iterate-kit-havpe`, XMOS 1.3.1 and this Wi-Fi MAC.                               |
| Satellite1                                   | `14:C1:9F:4F:D2:14`  | Previously identified during recovery; see [bench notes](bench-notes.md#satellite1-rom-recovery-record). |

Waveshare ESP32-S3 RLCD 4.2 has USB serial `94:A9:90:CD:51:B8`.
Factory boot reported `03_Fac`, ES8311/ES7210 and the vendor's RLCD wiring;
Jonas confirmed the display and KEY-button path on this unit.
See its [board notes](devices/waveshare_s3_rlcd/README.md).

ZECTRIX NOTE4 has USB serial `80:45:6B:38:60:84`. Factory boot identifies
`zectrix-s3-epaper-4.2`, xiaozhi 3.6.2. Its full factory backup and current
firmware are documented in [NOTE4 board notes](devices/zectrix_note4/README.md).

Resolve a device's current port passively from the repository root:

```sh
apps/kit/firmware/tools/port-for-mac.sh D8:3B:DA:46:20:34
```

`esptool read_mac` and serial monitors can reset a board. Identify it through
USB metadata before opening its port; leave other attached devices alone.

The HAVPE targets `https://os.iterate.com`, project slug `prj-kit-bench`,
canonical project ID `prj_3afc6e86c9202218ef3c6b7059e5be82`. Its provisioning
uses the canonical ID and a project-scoped personal access token for the
existing `kit-bench@iterate.com` bench account. Credentials belong in the
provisioning partition, never in this file.
