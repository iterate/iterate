#!/usr/bin/env python3
"""Build the ITERKIT1 provisioning image a board reads at boot.

The format lives in `components/core/src/configuration.c` and this is its only
writer in the repo — before this, reprovisioning a board meant knowing the byte
layout by heart, which is why the four boards sat pointed at whatever
deployment they were last flashed against.

    16-byte header: "ITERKIT" '1' | u32le payload size | u32le CRC-32(payload)
    payload:        repeated { u8 field, u16le size, bytes value }

The CRC is the standard reflected CRC-32 the firmware computes by hand
(configuration.c) precisely so a host tool and every ESP target agree
byte for byte.

Write it with:
    esptool.py -p <port> write_flash 0x210000 <image>

0x210000 is the `iterate_kit` partition in every target's partitions.csv, and a
plain `idf.py flash` leaves it alone — only `--erase-all` wipes it.
"""

import argparse
import binascii
import pathlib
import sys

MAGIC = b"ITERKIT1"
HEADER_SIZE = 16
FIELDS = {
    "wifi-ssid": 1,
    "wifi-password": 2,
    "os-base-url": 3,
    "project-id": 4,
    "project-api-key": 5,
}
# The firmware's own bounds (configuration.h). Refusing here means a board
# rejects nothing at boot — a truncated field is a device that silently never
# connects, with no symptom but silence.
CAPACITY = {
    "wifi-ssid": 33,
    "wifi-password": 64,
    "os-base-url": 128,
    "project-id": 64,
    "project-api-key": 128,
}


def build(values: dict[str, str]) -> bytes:
    payload = bytearray()
    for name, field in FIELDS.items():
        value = values.get(name)
        if value is None:
            continue
        encoded = value.encode("utf-8")
        # capacity includes the NUL the firmware writes when copying out.
        if len(encoded) + 1 > CAPACITY[name]:
            raise SystemExit(
                f"{name} is {len(encoded)} bytes; the firmware holds {CAPACITY[name] - 1}"
            )
        payload += bytes([field]) + len(encoded).to_bytes(2, "little") + encoded
    crc = binascii.crc32(bytes(payload)) & 0xFFFFFFFF
    header = MAGIC + len(payload).to_bytes(4, "little") + crc.to_bytes(4, "little")
    assert len(header) == HEADER_SIZE
    return bytes(header + payload)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in FIELDS:
        parser.add_argument(f"--{name}")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    values = {name: getattr(args, name.replace("-", "_")) for name in FIELDS}
    missing = [n for n in ("os-base-url", "project-id", "project-api-key") if not values.get(n)]
    if missing:
        raise SystemExit(f"required: {', '.join('--' + m for m in missing)}")

    image = build(values)
    pathlib.Path(args.out).write_bytes(image)
    # Deliberately does NOT echo the key: this runs in terminals people paste.
    print(f"wrote {args.out} ({len(image)} bytes) for {values['project-id']} @ {values['os-base-url']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
