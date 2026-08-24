"""Shared deterministic helpers: hashing, canonical JSON, PRNG, PackBits."""

from __future__ import annotations

import hashlib
import json


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 16), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_json(value) -> str:
    """One canonical text form so identical data always hashes identically."""
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    )


def write_json(path, value) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(value, fh, sort_keys=True, indent=2)
        fh.write("\n")


class Xorshift32:
    """Tiny seeded PRNG for fixture art only; never used in the pipeline."""

    def __init__(self, seed: int) -> None:
        self.state = (seed & 0xFFFFFFFF) or 0x9E3779B9

    def next(self) -> int:
        x = self.state
        x ^= (x << 13) & 0xFFFFFFFF
        x ^= x >> 17
        x ^= (x << 5) & 0xFFFFFFFF
        self.state = x
        return x

    def below(self, bound: int) -> int:
        return self.next() % bound

    def pick(self, low: int, high: int) -> int:
        """Inclusive range."""
        return low + self.below(high - low + 1)


def rgb565(color: tuple[int, int, int]) -> int:
    r, g, b = color
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)


def parse_hex_color(text: str) -> tuple[int, int, int]:
    value = text.strip().lstrip("#")
    if len(value) != 6:
        raise ValueError(f"expected #rrggbb color, got {text!r}")
    return (
        int(value[0:2], 16),
        int(value[2:4], 16),
        int(value[4:6], 16),
    )


def packbits(data: bytes) -> bytes:
    """The exact PackBits dialect decoded by face_sprite_sheet.c."""
    result = bytearray()
    index = 0
    while index < len(data):
        run = 1
        while (
            index + run < len(data)
            and data[index + run] == data[index]
            and run < 128
        ):
            run += 1
        if run >= 3:
            result.append(257 - run)
            result.append(data[index])
            index += run
            continue
        start = index
        index += 1
        while index < len(data) and index - start < 128:
            if (
                index + 2 < len(data)
                and data[index] == data[index + 1] == data[index + 2]
            ):
                break
            index += 1
        literal = data[start:index]
        result.append(len(literal) - 1)
        result.extend(literal)
    return bytes(result)


def unpackbits(data: bytes, expected: int) -> bytes:
    """Reference decoder mirroring stream_next(); used by validation."""
    out = bytearray()
    pos = 0
    while len(out) < expected:
        if pos >= len(data):
            raise ValueError("PackBits stream truncated")
        control = data[pos]
        pos += 1
        if control == 128:
            continue
        if control > 128:
            if pos >= len(data):
                raise ValueError("PackBits repeat missing byte")
            out.extend(bytes((data[pos],)) * (257 - control))
            pos += 1
        else:
            count = control + 1
            if pos + count > len(data):
                raise ValueError("PackBits literal truncated")
            out.extend(data[pos : pos + count])
            pos += count
    if len(out) != expected or pos != len(data):
        raise ValueError("PackBits stream does not end exactly at cell size")
    return bytes(out)


def fnv1a32(data: bytes) -> int:
    value = 0x811C9DC5
    for byte in data:
        value = ((value ^ byte) * 0x01000193) & 0xFFFFFFFF
    return value
