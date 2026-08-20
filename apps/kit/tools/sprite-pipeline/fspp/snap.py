"""Pixel-grid detection and snapping.

Image models emit "fake pixel art": a logical grid of fat pixels rendered
with wobbly cell boundaries, anti-aliased edges, and per-pixel color noise.
This stage estimates the logical pitch from edge-energy periodicity, then
resamples one robust color per logical cell so the rest of the pipeline works
on true pixel art.

Pitch is estimated per segmented cell and reconciled globally by the caller
(the sheet-wide median), because phase drifts across a large sheet while the
pitch itself stays stable.
"""

from __future__ import annotations

from dataclasses import dataclass

from .png_io import Image

MAX_PITCH = 24


@dataclass(frozen=True)
class Axis:
    pitch: int
    phase: int
    confidence: int  # percent; 100 = indistinguishable from flat


def _edge_energy(image: Image, axis: int) -> list[int]:
    """Summed |d luminance| across the axis: 0 = vertical edges (per x)."""
    width, height = image.width, image.height
    rgba = image.rgba
    lum = [0] * (width * height)
    for i in range(width * height):
        base = i * 4
        if rgba[base + 3] < 128:
            lum[i] = -1
            continue
        lum[i] = (
            299 * rgba[base] + 587 * rgba[base + 1] + 114 * rgba[base + 2]
        ) // 1000
    if axis == 0:
        energy = [0] * width
        for y in range(height):
            row = y * width
            for x in range(1, width):
                a = lum[row + x]
                b = lum[row + x - 1]
                if a < 0 or b < 0:
                    continue
                energy[x] += abs(a - b)
        return energy
    energy = [0] * height
    for y in range(1, height):
        row = y * width
        prev = row - width
        for x in range(width):
            a = lum[row + x]
            b = lum[prev + x]
            if a < 0 or b < 0:
                continue
            energy[y] += abs(a - b)
    return energy


def _peaks(energy: list[int]) -> list[int]:
    """Positions of significant local maxima, adjacent runs collapsed.

    Anti-aliasing smears one logical edge across neighbouring columns, so
    consecutive above-threshold positions count as one peak at the
    strongest column.
    """
    n = len(energy)
    if n == 0:
        return []
    mean = sum(energy) / n
    threshold = mean * 3 / 2
    peaks: list[int] = []
    run_start = None
    for i in range(n):
        if energy[i] > threshold:
            if run_start is None:
                run_start = i
        elif run_start is not None:
            run = range(run_start, i)
            peaks.append(max(run, key=lambda j: (energy[j], -j)))
            run_start = None
    if run_start is not None:
        run = range(run_start, n)
        peaks.append(max(run, key=lambda j: (energy[j], -j)))
    return peaks


def _detect_axis(energy: list[int]) -> Axis:
    """Pitch from the modal spacing between edge-energy peaks.

    Wobbly grids keep their average pitch even when individual lines drift
    by a pixel, so the spacing histogram (with +-1 neighbours pooled) is a
    far more stable signal than exact modular alignment.
    """
    n = len(energy)
    if n < 6 or sum(energy) == 0:
        return Axis(pitch=1, phase=0, confidence=100)
    peaks = _peaks(energy)
    spacings = [
        b - a for a, b in zip(peaks, peaks[1:]) if 2 <= b - a <= MAX_PITCH
    ]
    if len(spacings) < 4:
        return Axis(pitch=1, phase=0, confidence=100)
    counts: dict[int, int] = {}
    for spacing in spacings:
        counts[spacing] = counts.get(spacing, 0) + 1
    # Pool each candidate with its +-1 neighbours; wobble splits one true
    # pitch across adjacent spacing values.
    def pooled(pitch: int) -> int:
        return (
            counts.get(pitch - 1, 0)
            + counts.get(pitch, 0)
            + counts.get(pitch + 1, 0)
        )

    pitch = min(counts, key=lambda p: (-pooled(p), -counts[p], p))
    confidence = pooled(pitch) * 100 // len(spacings)
    if confidence < 60 or pooled(pitch) < 4:
        return Axis(pitch=1, phase=0, confidence=confidence)
    phase, _ = _best_phase(energy, pitch)
    return Axis(pitch=pitch, phase=phase, confidence=confidence)


def _best_phase(energy: list[int], pitch: int) -> tuple[int, int]:
    """(phase, score) maximizing edge energy on grid-line columns."""
    n = len(energy)
    best_phase = 0
    best_score = -1
    for phase in range(pitch):
        picks = range(phase, n, pitch)
        count = len(picks)
        if count < 2:
            continue
        score = sum(energy[i] for i in picks) // count
        if score > best_score:
            best_score = score
            best_phase = phase
    return best_phase, best_score


def phase_for_pitch(image: Image, axis: int, pitch: int) -> Axis:
    """Best phase for a known pitch (per-cell phase under global pitch)."""
    if pitch <= 1:
        return Axis(pitch=1, phase=0, confidence=100)
    energy = _edge_energy(image, axis)
    if len(energy) < 2 * pitch or sum(energy) == 0:
        return Axis(pitch=pitch, phase=0, confidence=100)
    phase, _ = _best_phase(energy, pitch)
    return Axis(pitch=pitch, phase=phase, confidence=100)


def detect_grid(image: Image) -> tuple[Axis, Axis]:
    return _detect_axis(_edge_energy(image, 0)), _detect_axis(
        _edge_energy(image, 1)
    )


def _block_edges(size: int, pitch: int, phase: int) -> list[int]:
    """Boundaries covering [0, size] aligned to phase + k*pitch."""
    start = phase % pitch
    edges = list(range(start, size + 1, pitch))
    if not edges or edges[0] != 0:
        edges.insert(0, 0)
    if edges[-1] != size:
        edges.append(size)
    return edges


def _median(values: list[int]) -> int:
    values = sorted(values)
    return values[len(values) // 2]


def snap(image: Image, x_axis: Axis, y_axis: Axis) -> Image:
    """Resample to the logical grid; per-channel median, alpha majority."""
    if x_axis.pitch <= 1 and y_axis.pitch <= 1:
        return image
    xs = _block_edges(image.width, x_axis.pitch, x_axis.phase)
    ys = _block_edges(image.height, y_axis.pitch, y_axis.phase)
    out = Image.blank(len(xs) - 1, len(ys) - 1)
    rgba = image.rgba
    width = image.width
    for by in range(len(ys) - 1):
        for bx in range(len(xs) - 1):
            reds: list[int] = []
            greens: list[int] = []
            blues: list[int] = []
            opaque = 0
            count = 0
            for y in range(ys[by], ys[by + 1]):
                row = y * width
                for x in range(xs[bx], xs[bx + 1]):
                    base = (row + x) * 4
                    count += 1
                    if rgba[base + 3] >= 128:
                        opaque += 1
                        reds.append(rgba[base])
                        greens.append(rgba[base + 1])
                        blues.append(rgba[base + 2])
            if count == 0 or opaque * 2 <= count:
                continue
            out.put(
                bx,
                by,
                (_median(reds), _median(greens), _median(blues), 255),
            )
    return out
