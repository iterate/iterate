"""Sheet segmentation: foreground mask -> named cell boxes.

Row bands come from the row projection of the keyed mask (image models keep
rows well separated). Within a band, cells are found by connected-component
clustering rather than column projection: neighbouring characters' ears and
props overlap in x-projection on real sheets, but they stay disconnected
components. The N largest components seed the N layout cells; components
that overlap a core's x-range substantially merge into it (split outlines),
and small satellites (sparkles, sweat drops, motion marks) attach to the
nearest core. Everything is deterministic.

Boxes mode trusts explicit rectangles from the spec instead.
"""

from __future__ import annotations

from dataclasses import dataclass

from .spec import LayoutSpec


class SegmentError(ValueError):
    pass


@dataclass(frozen=True)
class CellBox:
    name: str
    role: str  # "expression" | "mouth"
    x: int
    y: int
    w: int
    h: int


@dataclass
class _Component:
    min_x: int
    min_y: int
    max_x: int
    max_y: int
    size: int

    def absorb(self, other: "_Component") -> None:
        self.min_x = min(self.min_x, other.min_x)
        self.min_y = min(self.min_y, other.min_y)
        self.max_x = max(self.max_x, other.max_x)
        self.max_y = max(self.max_y, other.max_y)
        self.size += other.size

    @property
    def width(self) -> int:
        return self.max_x - self.min_x + 1

    def center(self) -> tuple[int, int]:
        return (
            (self.min_x + self.max_x) // 2,
            (self.min_y + self.max_y) // 2,
        )


def _runs(
    profile: list[int], threshold: int, max_gap: int
) -> list[tuple[int, int]]:
    """Inclusive (start, end) runs of profile>threshold, bridging gaps."""
    runs: list[tuple[int, int]] = []
    start = None
    end = None
    gap = 0
    for index, value in enumerate(profile):
        if value > threshold:
            if start is None:
                start = index
            end = index
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= max_gap:
                runs.append((start, end))
                start = None
    if start is not None:
        runs.append((start, end))
    return runs


def _components(
    mask: bytearray, width: int, y0: int, y1: int
) -> list[_Component]:
    """4-connected foreground components within rows [y0, y1]."""
    seen = bytearray(width * (y1 - y0 + 1))
    components: list[_Component] = []
    for row in range(y0, y1 + 1):
        base = row * width
        local_base = (row - y0) * width
        for x in range(width):
            if not mask[base + x] or seen[local_base + x]:
                continue
            component = _Component(x, row, x, row, 0)
            stack = [(x, row)]
            seen[local_base + x] = 1
            while stack:
                cx, cy = stack.pop()
                component.size += 1
                component.min_x = min(component.min_x, cx)
                component.max_x = max(component.max_x, cx)
                component.min_y = min(component.min_y, cy)
                component.max_y = max(component.max_y, cy)
                for nx, ny in (
                    (cx - 1, cy),
                    (cx + 1, cy),
                    (cx, cy - 1),
                    (cx, cy + 1),
                ):
                    if not (0 <= nx < width and y0 <= ny <= y1):
                        continue
                    li = (ny - y0) * width + nx
                    if mask[ny * width + nx] and not seen[li]:
                        seen[li] = 1
                        stack.append((nx, ny))
            components.append(component)
    return components


def _x_overlap(a: _Component, b: _Component) -> int:
    return min(a.max_x, b.max_x) - max(a.min_x, b.min_x) + 1


def _cluster_band(
    components: list[_Component], expected: int, band_label: str
) -> list[_Component]:
    if len(components) < expected:
        raise SegmentError(
            f"{band_label}: found {len(components)} components but layout "
            f"names {expected} cells"
        )
    ordered = sorted(
        components, key=lambda c: (-c.size, c.min_x, c.min_y)
    )
    cores = sorted(
        ordered[:expected], key=lambda c: (c.min_x, c.min_y)
    )
    rest = ordered[expected:]

    # Components overlapping most of a core's x-range are parts of the same
    # cell (broken outlines, detached hats); everything else is a satellite
    # that attaches to the nearest core center. A cell-sized component that
    # only attaches by distance means the sheet has more cells than the
    # layout names — refuse rather than silently blending characters.
    smallest_core = min(core.size for core in cores)
    for component in sorted(
        rest, key=lambda c: (-c.size, c.min_x, c.min_y)
    ):
        best = None
        best_key = None
        for index, core in enumerate(cores):
            overlap = _x_overlap(component, core)
            if overlap >= (component.width * 3) // 5:
                key = (0, -overlap, index)
            else:
                cx, cy = component.center()
                kx, ky = core.center()
                key = (1, abs(cx - kx) + abs(cy - ky), index)
            if best_key is None or key < best_key:
                best_key = key
                best = index
        if best_key[0] == 1 and component.size * 5 >= smallest_core * 3:
            raise SegmentError(
                f"{band_label}: a detached component of {component.size} "
                "pixels rivals the named cells; the layout row probably "
                "names too few cells"
            )
        cores[best].absorb(component)
    return cores


def segment(
    mask: bytearray,
    width: int,
    height: int,
    layout: LayoutSpec,
) -> list[CellBox]:
    if layout.mode == "boxes":
        return _segment_boxes(mask, width, layout)

    row_profile = [0] * height
    for y in range(height):
        row = y * width
        row_profile[y] = sum(mask[row : row + width])
    bands = _runs(row_profile, threshold=1, max_gap=layout.row_gap)
    if len(bands) != len(layout.rows):
        raise SegmentError(
            f"found {len(bands)} horizontal bands but layout describes "
            f"{len(layout.rows)} rows; adjust layout.row_gap or the sheet"
        )

    cells: list[CellBox] = []
    for (band_start, band_end), row_spec in zip(bands, layout.rows):
        components = _components(mask, width, band_start, band_end)
        # Ignore pure noise below a few pixels before clustering.
        components = [
            c
            for c in components
            if c.size >= 3 or len(components) <= len(row_spec.names)
        ]
        cores = _cluster_band(
            components,
            len(row_spec.names),
            f"band y={band_start}..{band_end}",
        )
        for core, name in zip(cores, row_spec.names):
            cells.append(
                CellBox(
                    name=name,
                    role=row_spec.role,
                    x=core.min_x,
                    y=core.min_y,
                    w=core.width,
                    h=core.max_y - core.min_y + 1,
                )
            )
    return cells


def _tighten(
    mask: bytearray, width: int, x0: int, x1: int, y0: int, y1: int
) -> tuple[int, int, int, int]:
    """Shrink the inclusive box to its true foreground bounds."""
    min_x, min_y = x1, y1
    max_x, max_y = x0, y0
    for y in range(y0, y1 + 1):
        row = y * width
        for x in range(x0, x1 + 1):
            if mask[row + x]:
                if x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
                if y < min_y:
                    min_y = y
                if y > max_y:
                    max_y = y
    if max_x < min_x:
        raise SegmentError("empty cell box after tightening")
    return min_x, min_y, max_x, max_y


def _segment_boxes(
    mask: bytearray, width: int, layout: LayoutSpec
) -> list[CellBox]:
    role_by_name: dict[str, str] = {}
    for row in layout.rows:
        for name in row.names:
            role_by_name[name] = row.role
    cells = []
    for name, (x, y, w, h) in sorted(layout.boxes.items()):
        role = role_by_name.get(name)
        if role is None:
            raise SegmentError(
                f"box {name!r} has no role; list it in layout.rows"
            )
        x0, y0, x1, y1 = _tighten(mask, width, x, x + w - 1, y, y + h - 1)
        cells.append(
            CellBox(
                name=name,
                role=role,
                x=x0,
                y=y0,
                w=x1 - x0 + 1,
                h=y1 - y0 + 1,
            )
        )
    return cells
