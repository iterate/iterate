"""Minimal deterministic PNG codec (stdlib only).

Decodes 8-bit and sub-byte greyscale/palette plus 8/16-bit RGB/RGBA PNGs into
a flat RGBA buffer. Encodes RGBA or indexed images with fixed filter and zlib
settings so identical pixels always produce identical files within one
interpreter/zlib build. Pixel-level hashes, not file hashes, are the
cross-machine determinism contract; see hash_rgba().
"""

from __future__ import annotations

import hashlib
import struct
import zlib
from dataclasses import dataclass

_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class PngError(ValueError):
    pass


@dataclass
class Image:
    """Flat RGBA image: 4 bytes per pixel, row-major."""

    width: int
    height: int
    rgba: bytearray

    @classmethod
    def blank(cls, width: int, height: int, color=(0, 0, 0, 0)) -> "Image":
        return cls(width, height, bytearray(bytes(color) * (width * height)))

    def get(self, x: int, y: int) -> tuple[int, int, int, int]:
        i = (y * self.width + x) * 4
        return tuple(self.rgba[i : i + 4])

    def put(self, x: int, y: int, color) -> None:
        if 0 <= x < self.width and 0 <= y < self.height:
            i = (y * self.width + x) * 4
            self.rgba[i : i + 4] = bytes(color)

    def opaque(self, x: int, y: int) -> bool:
        return self.rgba[(y * self.width + x) * 4 + 3] >= 128

    def crop(self, x: int, y: int, w: int, h: int) -> "Image":
        out = Image.blank(w, h)
        for row in range(h):
            sy = y + row
            if sy < 0 or sy >= self.height:
                continue
            x0 = max(0, x)
            x1 = min(self.width, x + w)
            if x0 >= x1:
                continue
            si = (sy * self.width + x0) * 4
            di = (row * w + (x0 - x)) * 4
            out.rgba[di : di + (x1 - x0) * 4] = self.rgba[
                si : si + (x1 - x0) * 4
            ]
        return out


def hash_rgba(image: Image) -> str:
    """Cross-platform content hash: dimensions plus raw RGBA bytes."""
    digest = hashlib.sha256()
    digest.update(struct.pack(">II", image.width, image.height))
    digest.update(bytes(image.rgba))
    return digest.hexdigest()


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _unfilter(raw: bytes, stride: int, height: int, bpp: int) -> bytearray:
    out = bytearray(stride * height)
    pos = 0
    for row in range(height):
        if pos >= len(raw):
            raise PngError("truncated IDAT data")
        ftype = raw[pos]
        pos += 1
        line = raw[pos : pos + stride]
        if len(line) < stride:
            raise PngError("truncated scanline")
        pos += stride
        base = row * stride
        prev = base - stride
        if ftype == 0:
            out[base : base + stride] = line
        elif ftype == 1:
            for i in range(stride):
                left = out[base + i - bpp] if i >= bpp else 0
                out[base + i] = (line[i] + left) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                up = out[prev + i] if row else 0
                out[base + i] = (line[i] + up) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                left = out[base + i - bpp] if i >= bpp else 0
                up = out[prev + i] if row else 0
                out[base + i] = (line[i] + (left + up) // 2) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                left = out[base + i - bpp] if i >= bpp else 0
                up = out[prev + i] if row else 0
                ul = out[prev + i - bpp] if (row and i >= bpp) else 0
                out[base + i] = (line[i] + _paeth(left, up, ul)) & 0xFF
        else:
            raise PngError(f"unsupported filter type {ftype}")
    return out


def decode(data: bytes) -> Image:
    if data[:8] != _SIGNATURE:
        raise PngError("not a PNG file")
    pos = 8
    width = height = 0
    bit_depth = color_type = 0
    palette = b""
    trns = b""
    idat = bytearray()
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            width, height, bit_depth, color_type, comp, filt, interlace = (
                struct.unpack(">IIBBBBB", body)
            )
            if comp or filt:
                raise PngError("unsupported compression/filter method")
            if interlace:
                raise PngError("interlaced PNG is not supported")
        elif ctype == b"PLTE":
            palette = body
        elif ctype == b"tRNS":
            trns = body
        elif ctype == b"IDAT":
            idat.extend(body)
        elif ctype == b"IEND":
            break
    if not width or not height:
        raise PngError("missing IHDR")
    raw = zlib.decompress(bytes(idat))

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color_type)
    if channels is None:
        raise PngError(f"unsupported color type {color_type}")

    if bit_depth == 8:
        samples = _unfilter(raw, width * channels, height, channels)
    elif bit_depth in (1, 2, 4) and color_type in (0, 3):
        packed_stride = (width * bit_depth + 7) // 8
        packed = _unfilter(raw, packed_stride, height, 1)
        samples = bytearray(width * height)
        mask = (1 << bit_depth) - 1
        for row in range(height):
            base = row * packed_stride
            for x in range(width):
                bit = x * bit_depth
                byte = packed[base + bit // 8]
                shift = 8 - bit_depth - (bit % 8)
                samples[row * width + x] = (byte >> shift) & mask
        if color_type == 0:
            scale = 255 // mask
            samples = bytearray(v * scale for v in samples)
    elif bit_depth == 16:
        wide = _unfilter(raw, width * channels * 2, height, channels * 2)
        samples = wide[0::2]
    else:
        raise PngError(f"unsupported bit depth {bit_depth}")

    image = Image.blank(width, height)
    out = image.rgba
    n = width * height
    if color_type == 0:
        for i in range(n):
            v = samples[i]
            j = i * 4
            out[j] = out[j + 1] = out[j + 2] = v
            out[j + 3] = 255
    elif color_type == 2:
        for i in range(n):
            s = i * 3
            j = i * 4
            out[j : j + 3] = samples[s : s + 3]
            out[j + 3] = 255
    elif color_type == 3:
        for i in range(n):
            idx = samples[i]
            p = idx * 3
            if p + 3 > len(palette):
                raise PngError("palette index out of range")
            j = i * 4
            out[j : j + 3] = palette[p : p + 3]
            out[j + 3] = trns[idx] if idx < len(trns) else 255
    elif color_type == 4:
        for i in range(n):
            s = i * 2
            j = i * 4
            out[j] = out[j + 1] = out[j + 2] = samples[s]
            out[j + 3] = samples[s + 1]
    elif color_type == 6:
        out[:] = samples
    return image


def _chunk(ctype: bytes, body: bytes) -> bytes:
    return (
        struct.pack(">I", len(body))
        + ctype
        + body
        + struct.pack(">I", zlib.crc32(ctype + body) & 0xFFFFFFFF)
    )


def encode_rgba(image: Image) -> bytes:
    stride = image.width * 4
    raw = bytearray()
    for row in range(image.height):
        raw.append(0)
        raw.extend(image.rgba[row * stride : (row + 1) * stride])
    ihdr = struct.pack(">IIBBBBB", image.width, image.height, 8, 6, 0, 0, 0)
    return (
        _SIGNATURE
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        + _chunk(b"IEND", b"")
    )


def encode_indexed(
    width: int,
    height: int,
    indices: bytes,
    palette_rgb: list[tuple[int, int, int]],
    transparent_index: int | None = None,
) -> bytes:
    """Encode an 8-bit indexed PNG; palette order is preserved exactly."""
    if len(indices) != width * height:
        raise PngError("index buffer does not match dimensions")
    if len(palette_rgb) > 256:
        raise PngError("palette too large")
    raw = bytearray()
    for row in range(height):
        raw.append(0)
        raw.extend(indices[row * width : (row + 1) * width])
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 3, 0, 0, 0)
    plte = b"".join(bytes(c) for c in palette_rgb)
    out = _SIGNATURE + _chunk(b"IHDR", ihdr) + _chunk(b"PLTE", plte)
    if transparent_index is not None:
        trns = bytes(
            0 if i == transparent_index else 255
            for i in range(transparent_index + 1)
        )
        out += _chunk(b"tRNS", trns)
    out += _chunk(b"IDAT", zlib.compress(bytes(raw), 6))
    out += _chunk(b"IEND", b"")
    return out


def load(path) -> Image:
    with open(path, "rb") as fh:
        return decode(fh.read())


def save_rgba(path, image: Image) -> None:
    with open(path, "wb") as fh:
        fh.write(encode_rgba(image))
