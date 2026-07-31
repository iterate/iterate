#!/usr/bin/env python3
"""Fail unless ESP-IDF selected Iterate's audited CoreS3 BSP component."""

from __future__ import annotations

import json
import sys
from pathlib import Path


COMPONENT_NAME = "espressif__m5stack_core_s3"
PATCHED_SOURCE_NAMES = {"m5stack_core_s3.c", "m5stack_core_s3_idf5.c"}


def fail(message: str) -> None:
    raise SystemExit(f"CoreS3 BSP source-selection regression: {message}")


def main() -> None:
    if len(sys.argv) != 3:
        fail("expected PROJECT_DESCRIPTION EXPECTED_COMPONENT_DIR")

    description_path = Path(sys.argv[1]).resolve()
    expected_component_dir = Path(sys.argv[2]).resolve()
    description = json.loads(description_path.read_text(encoding="utf-8"))

    try:
        component = description["build_component_info"][COMPONENT_NAME]
    except KeyError:
        fail(f"{COMPONENT_NAME} is absent from {description_path}")

    selected_component_dir = Path(component["dir"]).resolve()
    if selected_component_dir != expected_component_dir:
        fail(
            "ESP-IDF selected "
            f"{selected_component_dir}, expected {expected_component_dir}"
        )

    sources = [Path(source).resolve() for source in component.get("sources", [])]
    if {source.name for source in sources} != PATCHED_SOURCE_NAMES:
        fail(f"unexpected BSP source set: {sources}")

    # A project can appear to compile against the local component while its
    # source list still names the pristine registry checkout. That silently
    # loses the bounded DMA queue and echo-reference tap we rely on at runtime,
    # so the build artifact must prove both patched translation units won.
    if any(source.parent.name != "iterate_patched" for source in sources):
        fail(f"unpatched CoreS3 BSP source selected: {sources}")
    if any("managed_components" in source.parts for source in sources):
        fail(f"managed CoreS3 BSP source leaked into the build: {sources}")

    required_header = (
        expected_component_dir
        / "include"
        / "iterate"
        / "kit"
        / "platforms"
        / "core_s3_bsp_audio.h"
    )
    if not required_header.is_file():
        fail(f"Iterate BSP API header is missing: {required_header}")

    print(
        "CoreS3 BSP source selection verified: "
        f"{selected_component_dir} -> {', '.join(map(str, sources))}"
    )


if __name__ == "__main__":
    main()
