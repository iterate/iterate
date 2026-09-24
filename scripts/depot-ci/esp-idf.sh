#!/usr/bin/env bash
# ESP-IDF for Kit Firmware's build legs (.depot/workflows/kit-firmware.yml). This file is the pin.
#
#   esp-idf.sh install  Clone the pin into $IDF_PATH, install its tools and Python environment into
#                       $IDF_TOOLS_PATH, then write a receipt of this file. The CI image bake
#                       (bake-preview-ci-image.sh) runs it, so the image carries ESP-IDF.
#   esp-idf.sh ensure   Use the image's install when its receipt matches this file, downloading
#                       nothing. Otherwise warn and install from GitHub, dl.espressif.com and PyPI,
#                       which happens only while this file differs from the one the image was baked
#                       with: a pull request that changes it, or main until the image bake that change
#                       triggers finishes. Hands IDF_PATH and IDF_TOOLS_PATH to later steps ($GITHUB_ENV).
set -euo pipefail

version=v5.4.2
commit=f5c3654a1c2d2a01f7f67def7a0dc48e691f63c0
target=esp32s3
# In the image, beside the baked pnpm store and browsers; tests point them elsewhere.
export IDF_PATH="${IDF_PATH:-/home/runner/esp-idf}"
export IDF_TOOLS_PATH="${IDF_TOOLS_PATH:-/home/runner/.espressif}"
receipt="$IDF_TOOLS_PATH/iterate-esp-idf.receipt"
# Any edit here (the pin, the target, the install) makes an older image's install stale.
expected="$(git hash-object "${BASH_SOURCE[0]}")"

install_esp_idf() {
  rm -rf "$IDF_PATH" "$IDF_TOOLS_PATH"
  # Shallow submodules as ESP-IDF's own image clones (tools/docker/Dockerfile, IDF_CLONE_SHALLOW).
  git clone --depth 1 --recursive --shallow-submodules --branch "$version" \
    https://github.com/espressif/esp-idf.git "$IDF_PATH"
  test "$(git -C "$IDF_PATH" rev-parse HEAD)" = "$commit"
  "$IDF_PATH/install.sh" "$target"
  # The downloaded tool archives, already unpacked under $IDF_TOOLS_PATH/tools.
  rm -rf "$IDF_TOOLS_PATH/dist"
  echo "$expected" >"$receipt"
}

case "${1:-}" in
  install)
    install_esp_idf
    ;;
  ensure)
    found="$(cat "$receipt" 2>/dev/null || echo none)"
    if [ "$found" = "$expected" ]; then
      echo "Using the CI image's ESP-IDF $version ($IDF_PATH, $IDF_TOOLS_PATH); nothing to download."
    else
      echo "::warning::The CI image's ESP-IDF receipt ($found) is not scripts/depot-ci/esp-idf.sh ($expected), so this leg installs ESP-IDF $version from the network. The image bake on main refreshes it."
      install_esp_idf
    fi
    if [ -n "${GITHUB_ENV:-}" ]; then
      printf 'IDF_PATH=%s\nIDF_TOOLS_PATH=%s\n' "$IDF_PATH" "$IDF_TOOLS_PATH" >>"$GITHUB_ENV"
    fi
    ;;
  *)
    echo "usage: $0 install|ensure" >&2
    exit 2
    ;;
esac
