"""Shared face vocabulary.

Mirrors the firmware conventions in firmware-ws/main/face_sprite_sheet.h and
tools/generate_sprite_showcase.py so FSPP atlases stay drop-in compatible
with the existing FSPR v2 player, the 12-byte face_keyframe_t prefix, and the
40-byte face_render_key_t viseme vocabulary fields.
"""

from __future__ import annotations

from dataclasses import dataclass

# The 23 named mouth slots every atlas carries. Order is the wire order of
# each bank's uint16_t mouth array.
MOUTH_SLOT_NAMES = (
    "sil",
    "pp",
    "ff",
    "th",
    "dd",
    "kk",
    "ch",
    "ss",
    "nn",
    "rr",
    "aa",
    "e",
    "ih",
    "oh",
    "ou",
    "smile",
    "frown",
    "grin",
    "tongue",
    "pucker",
    "gasp",
    "lateral",
    "smirk",
)

MOUTH_ROLE_NAMES = (
    "rest",
    "press",
    "teeth",
    "half",
    "wide",
    "round",
    "pucker",
    "lip_bite",
    "tongue",
)

# Slot index -> canonical face_sprite_mouth_role_t.
MOUTH_ROLES = (
    0,  # sil -> rest
    1,  # pp -> press
    7,  # ff -> lip bite
    8,  # th -> tongue
    3,  # dd -> half
    3,  # kk -> half
    5,  # ch -> round
    2,  # ss -> teeth
    1,  # nn -> press
    5,  # rr -> round
    4,  # aa -> wide
    4,  # e -> wide
    3,  # ih -> half
    5,  # oh -> round
    6,  # ou -> pucker
    4,  # smile -> wide
    3,  # frown -> half
    2,  # grin -> teeth
    8,  # tongue
    6,  # pucker
    5,  # gasp
    3,  # lateral
    3,  # smirk
)

# Preferred slot per role when the sheet provides it, matching the showcase
# atlases' fallback_slots. Build-time fallback walks this slot first, then any
# other authored slot sharing the role, then rest.
ROLE_PREFERRED_SLOTS = (0, 1, 17, 4, 10, 13, 19, 2, 18)

MOUTH_SLOT_NONE = 0xFF
CELL_NONE = 0xFFFF

# face_viseme_set_t values.
VISEME_SET_OVR15 = 0
VISEME_SET_VRM5 = 1
VISEME_SET_PRESTON9 = 2
VISEME_SET_MICROSOFT22 = 3
VISEME_SET_CUSTOM = 255

VISEME_SET_SLOTS = {
    # OVR15 enumerator order from face_pose.h.
    VISEME_SET_OVR15: (10, 11, 12, 13, 14, 1, 7, 3, 4, 2, 5, 8, 9, 6, 0),
    # VRM A/I/U/E/O.
    VISEME_SET_VRM5: (10, 12, 14, 11, 13),
    # Preston/Rhubarb X A B C D E F G H.
    VISEME_SET_PRESTON9: (0, 1, 7, 12, 10, 13, 14, 2, 18),
    # Microsoft 22 IDs map losslessly onto the first 22 slots.
    VISEME_SET_MICROSOFT22: tuple(range(22)),
}

VISEME_SET_NAMES = {
    VISEME_SET_OVR15: "ovr15",
    VISEME_SET_VRM5: "vrm5",
    VISEME_SET_PRESTON9: "preston9",
    VISEME_SET_MICROSOFT22: "microsoft22",
    VISEME_SET_CUSTOM: "custom",
}

# One custom entry demonstrating the unbounded vocabulary path, matching the
# showcase and mossling atlases: custom set, viseme 42 -> smirk.
CUSTOM_VISEME_ENTRIES = ((VISEME_SET_CUSTOM, 42, 22),)


def build_viseme_map() -> list[tuple[int, int, int, int]]:
    """(viseme_set, viseme, mouth_slot, role) rows in emission order."""
    rows: list[tuple[int, int, int, int]] = []
    for viseme_set in (
        VISEME_SET_OVR15,
        VISEME_SET_VRM5,
        VISEME_SET_PRESTON9,
        VISEME_SET_MICROSOFT22,
    ):
        for viseme, slot in enumerate(VISEME_SET_SLOTS[viseme_set]):
            rows.append((viseme_set, viseme, slot, MOUTH_ROLES[slot]))
    for viseme_set, viseme, slot in CUSTOM_VISEME_ENTRIES:
        rows.append((viseme_set, viseme, slot, MOUTH_ROLES[slot]))
    return rows


@dataclass(frozen=True)
class ExpressionTarget:
    """A face_sprite_expression_target_t action-space location."""

    slug: str
    valence: int
    arousal: int
    mouth_corner: int
    brow_inner: int
    eye_squint: int


# The eleven resolved action targets from face_stage.c. Banks are selected by
# proximity in this action space, never by a stage enum.
CANONICAL_EXPRESSIONS = (
    ExpressionTarget("neutral", 0, 72, 0, 0, 0),
    ExpressionTarget("warm", 52, 112, 36, 10, 20),
    ExpressionTarget("joy", 94, 184, 78, 22, 68),
    ExpressionTarget("concern", -52, 126, -24, 58, 14),
    ExpressionTarget("surprise", 18, 232, 8, 78, 0),
    ExpressionTarget("thoughtful", 4, 92, -6, 18, 22),
    ExpressionTarget("skeptical", -18, 104, -12, -14, 42),
    ExpressionTarget("determined", 12, 166, -8, -34, 54),
    ExpressionTarget("sleepy", 8, 34, 4, -26, 118),
    ExpressionTarget("excited", 86, 250, 62, 52, 14),
    ExpressionTarget("embarrassed", 28, 176, 24, 24, 116),
)

CANONICAL_BY_SLUG = {item.slug: item for item in CANONICAL_EXPRESSIONS}


def action_distance(a: ExpressionTarget, b: ExpressionTarget) -> int:
    """The player's weighted L1 bank-selection metric (select_bank)."""
    return (
        3 * abs(a.valence - b.valence)
        + abs(a.arousal - b.arousal)
        + 2 * abs(a.mouth_corner - b.mouth_corner)
        + 2 * abs(a.brow_inner - b.brow_inner)
        + abs(a.eye_squint - b.eye_squint)
    )


def resolve_fallback_slots(present_slots: set[int]) -> list[int]:
    """role -> slot table; every role resolves to an authored slot.

    Preference order per role: the showcase's preferred slot, then the
    lowest-numbered authored slot sharing the role, then rest (slot of role
    0), which is required to exist.
    """
    rest_candidates = [
        slot for slot in present_slots if MOUTH_ROLES[slot] == 0
    ]
    if not rest_candidates:
        raise ValueError(
            "no rest-role mouth cel authored; a 'sil' style cel is required"
        )
    rest_slot = (
        0 if 0 in present_slots else min(rest_candidates)
    )
    table: list[int] = []
    for role in range(len(ROLE_PREFERRED_SLOTS)):
        preferred = ROLE_PREFERRED_SLOTS[role]
        if preferred in present_slots:
            table.append(preferred)
            continue
        sharing = [
            slot for slot in sorted(present_slots)
            if MOUTH_ROLES[slot] == role
        ]
        table.append(sharing[0] if sharing else rest_slot)
    return table


def fill_mouth_slots(authored: dict[int, int]) -> tuple[list[int], list[int]]:
    """Expand authored {slot: cell} to all 23 slots.

    Returns (cells_per_slot, source_slot_per_slot). Missing slots borrow the
    cell of the fallback slot for their role, so the player needs no extra
    fallback logic and every viseme in every vocabulary lands on real pixels.
    """
    fallback = resolve_fallback_slots(set(authored))
    cells: list[int] = []
    sources: list[int] = []
    for slot in range(len(MOUTH_SLOT_NAMES)):
        if slot in authored:
            cells.append(authored[slot])
            sources.append(slot)
        else:
            source = fallback[MOUTH_ROLES[slot]]
            cells.append(authored[source])
            sources.append(source)
    return cells, sources
