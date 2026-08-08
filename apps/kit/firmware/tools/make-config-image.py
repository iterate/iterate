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
    esptool.py -p <port> write_flash "$(… --offset-for <target>)" <image>

THE OFFSET IS NOT THE SAME ON EVERY BOARD, and assuming it is corrupts the app.
It follows the app partition, which differs by flash size and image:

    m5sticks3  0x210000     waveshare  0x410000     havpe/stackchan  0x510000

Writing M5Stick's offset to a HAVPE puts 196 bytes inside its application image
and leaves the real config untouched, so the board keeps talking to whatever
deployment it was provisioned for and looks simply absent. `--offset-for`
reads the target's own partitions.csv, which is the only authority.

A plain `idf.py flash` leaves the partition alone — only `--erase-all` wipes it.
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


def offset_for(target: str) -> str:
    """The `iterate_kit` offset from a target's own partitions.csv."""
    csv = pathlib.Path(__file__).resolve().parents[1] / "targets" / target / "partitions.csv"
    if not csv.exists():
        raise SystemExit(f"no partitions.csv for target {target!r} at {csv}")
    for line in csv.read_text().splitlines():
        if line.strip().startswith("iterate_kit"):
            return line.split(",")[3].strip()
    raise SystemExit(f"{csv} declares no iterate_kit partition")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--offset-for",
        help="Print the iterate_kit flash offset for this target and exit.",
    )
    for name in FIELDS:
        parser.add_argument(f"--{name}")
    parser.add_argument("--out")
    args = parser.parse_args()

    if args.offset_for is not None:
        print(offset_for(args.offset_for))
        return 0
    if args.out is None:
        raise SystemExit("--out is required when building an image")

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
