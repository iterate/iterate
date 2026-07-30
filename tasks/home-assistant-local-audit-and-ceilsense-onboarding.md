---
state: done
priority: high
size: medium
dependsOn: []
tags: [home-assistant, esphome, ceilsense, local-hardware, audit]
---

# Local Home Assistant audit, upgrade, and CeilSense onboarding

Date: 2026-07-30  
Final verification: 2026-07-30 13:45 BST

Related architecture proposal:
[`home-assistant-stream-bridge-proposal.md`](./home-assistant-stream-bridge-proposal.md)

## Outcome

The Home Assistant installation is reachable, supported, healthy, fully
updated, and now has the high-end CeilSense Pro connected through the native
ESPHome integration.

- Home Assistant: [`http://homeassistant.local:8123`](http://homeassistant.local:8123)
- Home Assistant IPv4 address: `192.168.0.138`
- Hardware: Home Assistant Green
- Observer: [`http://192.168.0.138:4357`](http://192.168.0.138:4357)
- Observer final result: `Supervisor: Connected`, `Support: Supported`,
  `Health: Healthy`
- Home Assistant Core: `2026.7.4`
- Home Assistant Operating System: `18.1`
- Home Assistant Supervisor: `2026.07.5`
- Outstanding available updates: zero
- Home Assistant repair issues: zero
- CeilSense device: `CeilSense 9ec298`
- CeilSense hostname: `ceilsense-9ec298.local`
- CeilSense IPv4 address at onboarding: `192.168.0.193`
- CeilSense firmware: `1.34`
- CeilSense hardware/firmware variant: `v1-complete-wifi-ld2412`
- CeilSense ESPHome config entry: loaded
- CeilSense entity registry entries: 62 total, 57 enabled
- CeilSense unavailable enabled entities: zero

The installation was upgraded in place instead of being wiped. A full backup
was made first. Wiping was unnecessary because the supported upgrade path
completed successfully and the resulting system passed the health checks.

## Secret handling

The Home Assistant login and Wi-Fi credentials supplied for this work are not
recorded in this file.

They must not be added to the repository, copied into the architecture
proposal, or included in logs or screenshots. This record intentionally
contains only non-secret hostnames, local addresses, versions, identifiers,
and test results.

## Scope and constraints

The work covered:

1. Finding the Home Assistant installation on the local network.
2. Authenticating and auditing the installation.
3. Taking a pre-upgrade backup.
4. Updating Home Assistant Core, Home Assistant OS, Supervisor, add-ons, and
   reachable device firmware.
5. Rebooting the Home Assistant Green and checking the resulting state.
6. Identifying the USB-connected high-end CeilSense precisely.
7. Installing the latest official local ESPHome firmware over USB.
8. Provisioning the CeilSense onto the existing LAN over USB Improv Serial.
9. Accepting its native ESPHome discovery in Home Assistant.
10. Checking live device entities and doing a clean-window health audit.

The final user constraint was explicit: use the CeilSense USB connection, do
not use its Wi-Fi access point, and do not change the computer's Wi-Fi.

Before that correction, the computer briefly joined the CeilSense setup access
point during an initial connectivity check. It was immediately returned to its
original network after the correction. No router settings or Home Assistant
network settings were changed. All subsequent flashing and provisioning used
`/dev/cu.usbserial-0001`; the computer remained on its original Wi-Fi with
address `192.168.0.169` and gateway `192.168.0.1`.

## Home Assistant discovery

Home Assistant was found through both normal local naming and direct LAN
access:

| Item | Result |
| --- | --- |
| Local URL | `http://homeassistant.local:8123` |
| IPv4 | `192.168.0.138` |
| mDNS service | `_home-assistant._tcp`, instance `Home` |
| Hardware | Home Assistant Green |
| Observer | `http://192.168.0.138:4357` |
| Authenticated user | Owner and administrator |

The Home Assistant Observer reported healthy before the upgrades and again
after the final reboot and CeilSense onboarding.

## Initial audit

The initial state was operational but significantly behind the current
release and included disconnected historical devices.

### Platform versions before work

| Component | Initial version |
| --- | --- |
| Home Assistant Core | `2025.12.5` |
| Home Assistant Operating System | `16.3` |
| Home Assistant Supervisor | `2026.07.3` |

There were 12 available update entities.

### Initial inventory

| Item | Initial result |
| --- | ---: |
| Runtime states | 129 |
| Devices | 27 |
| Entities | 113 |
| Areas | 4 |
| Unavailable runtime states | 87 |
| Config entries | 23 |
| Loaded config entries | 19 |
| Not-loaded config entries | 2 |
| Retrying config entries | 2 |
| Repair issues | 0 |

The high unavailable count did not indicate a failing Home Assistant host. It
was mostly attributable to devices that were switched off, removed, or not
plugged in, including a Climate Sensor W100, Candeo dimmer, Sonos devices,
Z-Wave plug, iPhone sensors, Home Assistant Voice, and Zigbee hardware.

### Config entries needing explanation

| Integration | State | Explanation |
| --- | --- | --- |
| ZHA — SONOFF Dongle Plus MG24 | `not_loaded` | Entry source is `ignore`; this is an intentionally ignored discovery. |
| Home Assistant Connect ZBT-2 | `setup_retry` | Home Assistant reports: `The device is not plugged in`. |
| ZHA — Home Assistant Connect ZBT-2 | `setup_retry` | The recorded serial device `/dev/serial/by-id/usb-Nabu_Casa_ZBT-2_DCB4D90C332C-if00` does not exist. |
| ESPHome — Home Assistant Voice 09c455 | `not_loaded` | Disabled by the user. |

These entries remain historical/disconnected inventory. They do not block the
new CeilSense, but they mean the device inventory is not entirely clean even
though the Home Assistant host itself is healthy.

### Storage

At the initial audit, storage was 30% used with approximately 18.2 GB free.

## Pre-upgrade backup

A full manual backup was created before changing any software:

| Item | Value |
| --- | --- |
| Name | `Pre-upgrade 2026-07-30` |
| Supervisor slug | `debfa520` |
| Result | Completed successfully |

The UI subsequently showed two manual backups totaling 3.12 MB.

The Supervisor logged a warning that an `addons/local` backup folder did not
exist. That folder was not needed for the backup, and the full backup still
completed successfully.

## Updates applied

All 12 initially available updates were installed. Supervisor also updated
itself during the process.

| Component | Final version | Final update state |
| --- | --- | --- |
| Home Assistant Core | `2026.7.4` | Current |
| Home Assistant Operating System | `18.1` | Current |
| Home Assistant Supervisor | `2026.07.5` | Current |
| Z-Wave JS | `1.6.0` | Current |
| Matter Server | `9.1.1` | Current |
| Cloudflared | `7.0.11` | Current |
| File editor | `6.0.0` | Current |
| OpenThread Border Router | `3.0.2` | Current |
| SONOFF Dongle Flasher | `1.3.4` | Current |
| Piper | `2.3.1` | Current |
| ESPHome Device Builder | `2026.7.3` | Current |
| Speech-to-Phrase | `1.4.3` | Current |
| Home Assistant Connect ZWA-2 firmware | `1.2` | Current |

Installing Home Assistant OS 18.1 required an explicit host reboot. The Home
Assistant Green rebooted successfully, Observer returned healthy, and Core
completed its first boot and migration.

### Update-time events and classifications

The following messages occurred during the upgrade. Each was checked against
the resulting state rather than silently ignored:

- Home Assistant rejected duplicate install calls for File editor,
  Speech-to-Phrase, and ESPHome Device Builder because each update was already
  in progress. All three later reported the requested current version.
- The old Z-Wave JS add-on container exited with code 137 during its controlled
  replacement. Supervisor then reported the update successful and started the
  new `1.6.0` app.
- The first ZWA-2 firmware attempt encountered `ZW0111` while the controller
  instance was being destroyed during the Z-Wave JS replacement.
- A later ZWA-2 firmware request returned `ZW0263`, saying that the image was
  for a different original firmware version. At that point the device already
  reported installed `1.2` and latest `1.2`, so this was a rejected attempt to
  reapply firmware that had already succeeded.
- Speech-to-Phrase exceeded a 120-second startup wait during the host reboot,
  but it subsequently made WebSocket connections and completed its update to
  `1.4.3`.
- Home Assistant recorded one temporary timeout connecting to Supervisor
  during the reboot. Supervisor then completed its system checks, evaluation,
  and autofix pass and reported itself up and running.

After documenting these events, the volatile Home Assistant system-log list
was cleared to establish a new observation window. After 20 seconds with the
CeilSense connected, the list remained empty: no new errors or warnings
recurred.

## CeilSense USB identification

The target was identified independently from the other USB serial devices
attached to the computer.

| Item | Result |
| --- | --- |
| Serial device | `/dev/cu.usbserial-0001` |
| USB bridge | Silicon Labs CP2102 USB-to-UART |
| USB vendor/product | `0x10c4` / `0xea60` |
| USB serial | `0001` |
| MCU | ESP32-S3 QFN56 revision 0.2 |
| Features | Wi-Fi, Bluetooth 5, dual core, 2 MB embedded PSRAM |
| Flash | 4 MB, quad mode, 3.3 V |
| Device MAC | `80:b5:4e:9e:c2:98` |

Four separate Espressif USB JTAG/serial devices were also present as
`/dev/cu.usbmodem11101` through `/dev/cu.usbmodem11401`. Their attach history
and identifiers showed that they were unrelated, so none of them was flashed.

### Existing firmware read

A read-only 4 MB flash capture was inspected before erasing the device. Its
embedded metadata established the exact model:

```text
Project smarthomeshop.ceilsense version 1.27
v1-complete-wifi-ld2412
ceilsense-complete-wifi-ld2412.yaml
```

This confirms that the connected high-end model is the Complete Wi-Fi variant
with:

- LD2412 presence radar;
- SCD41 CO₂, temperature, and humidity sensing;
- BH1750 illuminance sensing;
- BMP3xx pressure/temperature sensing; and
- the broader Complete-model controls and diagnostics.

The temporary full-flash capture was moved to Trash after identification and
was not added to the repository.

## Official firmware installation over USB

The installed image came from the official SmartHomeShop release manifest:

- [CeilSense firmware selector](https://smarthomeshop.io/en/firmware?product=ceilsense)
- [Complete Wi-Fi + LD2412 manifest](https://smarthomeshop.github.io/ceilsense/ceilsense-complete-wifi-ld2412-manifest.json)
- [CeilSense source](https://github.com/smarthomeshop/ceilsense)

Manifest data:

| Item | Value |
| --- | --- |
| Manifest name | `CeilSense Complete WiFi LD2412` |
| Manifest version | `1.34` |
| Home Assistant domain | `esphome` |
| Chip family | `ESP32-S3` |
| Factory image offset | `0x0` |
| Factory image size | 1,550,576 bytes |
| Factory image SHA-256 | `12a19b67a18b73d54d26f533edad1e6da801b2b20ca0dfc68051489db7293bf1` |
| Official OTA MD5 from manifest | `74d6e65e45daa223bb3b1e8d53b4afdc` |

The operation used `esptool 5.3.1` on
`/dev/cu.usbserial-0001`:

1. Detect and verify the ESP32-S3 and MAC.
2. Erase the 4 MB flash.
3. Write the official factory image at offset `0x0` at 921,600 baud.
4. Perform esptool's immediate written-data hash verification.
5. Boot the device and query it through Improv Serial.

The immediate write-time data hash passed.

A second whole-image comparison after the device booted reported a mismatch.
This was investigated byte-for-byte rather than dismissed. Exactly 12 bytes
differed, all at `0x9000` through `0x901f`. The official partition table maps
that region to the `otadata` partition. The device wrote its valid boot/app
selection there on first boot. No immutable firmware bytes differed. This
fully explains the post-boot comparison result.

The temporary downloaded firmware image was moved to Trash after flashing.

## Wi-Fi provisioning over USB

Provisioning used the firmware's
[ESPHome Improv Serial](https://esphome.io/components/improv_serial/)
implementation at 115,200 baud on `/dev/cu.usbserial-0001`.

No connection was made to the CeilSense hotspot during this final workflow,
and no Wi-Fi setting on the computer was changed.

The device returned:

```text
initial Improv state: 2 (ready)
firmware project: smarthomeshop.ceilsense
firmware version: 1.34
chip family: ESP32-S3
device name: ceilsense-9ec298
provisioning state: 3
provisioned state: 4
hardware: v1-complete-wifi-ld2412
LAN address: 192.168.0.193
```

Post-provisioning network checks:

| Check | Result |
| --- | --- |
| ICMP | 3/3 replies, 0% loss |
| mDNS | `ceilsense-9ec298.local` resolved to `192.168.0.193` |
| ESPHome Native API | TCP port 6053 accepted a connection |
| Device web server | HTTP port 80 returned the ESPHome web application |

The IP was assigned by DHCP and could change. Home Assistant uses zeroconf and
the ESPHome device identity, so scripts should prefer
`ceilsense-9ec298.local` or registry identity over hard-coding the current IP.

## Home Assistant integration

Home Assistant discovered the device automatically:

```text
CeilSense 9ec298 (ceilsense-9ec298)
ESPHome
```

The discovery was accepted through the normal Home Assistant config flow. No
custom component, cloud account, inbound Internet access, or SmartHomeShop
cloud mode was required.

Final registry data:

| Item | Result |
| --- | --- |
| Config entry title | `CeilSense 9ec298` |
| Config entry domain | `esphome` |
| Config entry source | `zeroconf` |
| Config entry state | `loaded` |
| Manufacturer | `smarthomeshop` |
| Model | `ceilsense` |
| Software | `1.34 (ESPHome 2026.7.2)` |
| Registry MAC | `80:b5:4e:9e:c2:98` |
| Assigned area | None |
| Entity registry entries | 62 |
| Enabled runtime entities | 57 |
| Integration-disabled diagnostic entities | 5 |
| Enabled entities in `unavailable` state | 0 |

The five integration-disabled entities are routine diagnostics/reset controls:

- Wi-Fi signal;
- ESP reset reason;
- ESP MAC;
- ESP IP address; and
- factory reset.

They were left at their integration defaults.

### Live readings at verification

These readings prove that Home Assistant is receiving actual device data, not
only holding a registry entry:

| Entity | Reading |
| --- | --- |
| Presence | On |
| Still target | On |
| Moving target | Off |
| Detection distance | 154 cm |
| Still energy | 100% |
| SCD41 CO₂ | 704 ppm |
| SCD41 humidity | 42.93% |
| SCD41 temperature | 34.39 °C |
| BH1750 illuminance | 252.64 lx |
| BMP3xx pressure | 1014.80 hPa |
| BMP3xx temperature | 43.17 °C |
| CPU temperature | 51.9 °C |
| LD2412 firmware | `1.26.25041209` |
| CeilSense software version | `1.34` |
| Hardware version | `v1-complete-wifi-ld2412` |
| Firmware variant selector | `WiFi (local)` |

The sensor was powered on a desk during onboarding, not mounted in its final
ceiling location. Its temperature values therefore should not be treated as
calibrated room temperature. The SCD41 manual fresh-air calibration and
LD2412 dynamic background correction were deliberately not triggered because
their physical preconditions were not established.

Some command-only buttons report `unknown`, as is normal until pressed.
Optional LD2412 gate/debug readings also report `unknown` while engineering or
debug mode is off. None of the 57 enabled entities reports `unavailable`.

## Final Home Assistant audit

| Check | Final result |
| --- | --- |
| Observer Supervisor connection | Connected |
| Observer support status | Supported |
| Observer health status | Healthy |
| Home Assistant repair issues | 0 |
| Available updates | 0 |
| Config entries | 25 |
| Loaded config entries | 21 |
| Not-loaded config entries | 2 |
| Retrying config entries | 2 |
| Runtime states | 174 |
| Unavailable runtime states | 73 |
| CeilSense enabled states | 57 |
| CeilSense unavailable states | 0 |
| Clean-window system errors/warnings | 0 |

Four firmware update entities remain `unavailable`, not `on`:

- Climate Sensor W100 firmware;
- Wave Plug UK firmware;
- Home Assistant Connect ZBT-2 firmware; and
- Candeo RD1-Pro Dimmer firmware.

Their parent devices are disconnected, so Home Assistant cannot determine
their installed or latest firmware. They are not outstanding runnable updates.

## Health verdict

The Home Assistant platform is healthy and current. Its supported update path
worked, it has a successful pre-upgrade backup, Observer is healthy, Repairs
is empty, no update is available, and no error or warning recurred during the
clean observation window.

The device inventory is not pristine because it still contains intentionally
ignored, user-disabled, or physically disconnected historical devices. That
is the source of the 73 unavailable states and four unavailable update
entities. Removing those entries would make the dashboard cleaner but is not
required for host health or CeilSense operation.

The CeilSense onboarding is complete. The high-end Complete Wi-Fi + LD2412
unit is on official firmware 1.34, was provisioned entirely over USB after the
USB-only instruction, is loaded through Home Assistant's native ESPHome
integration, and is delivering live sensor and presence data.

## Relevance to the Iterate bridge proposal

This installation is an immediate real-world validation target for
[`home-assistant-stream-bridge-proposal.md`](./home-assistant-stream-bridge-proposal.md):

- the CeilSense is already normalized into normal Home Assistant entities;
- every CeilSense state transition appears on Home Assistant's event bus;
- the proposed raw event firehose would therefore receive its sensor and
  presence changes without an Iterate-specific CeilSense protocol;
- the proposed live Home Assistant capability could read or control all 62
  registered CeilSense entities through ordinary Home Assistant WebSocket
  commands; and
- camera access, if added later, should use Home Assistant camera APIs for
  snapshots/streams rather than expecting image bytes in the event firehose.

