#!/usr/bin/env bash
# ESP-IDF for Kit Firmware's build legs (.depot/workflows/kit-firmware.yml). This file is the pin, and
# its hash, with python3's version, keys the ESP-IDF that Depot Cache holds for the legs
# (docs/depot-ci.md#depot-cache).
#
#   esp-idf.sh key      That key, as a step output ($GITHUB_OUTPUT).
#   esp-idf.sh ensure   Use the ESP-IDF the leg restored from Depot Cache when its receipt holds that
#                       key, downloading nothing. Otherwise warn, then clone the pin into
#                       $IDF_PATH, install its tools and Python environment into $IDF_TOOLS_PATH from
#                       GitHub, dl.espressif.com and PyPI, and write the receipt: only while Depot
#                       Cache holds none for the key, on a pull request that changes this file or on
#                       main until a leg saves one. Hands IDF_PATH and IDF_TOOLS_PATH to later steps
#                       ($GITHUB_ENV).
set -euo pipefail

version=v6.1
commit=fff9895c82d744c7237be8847347bdd1b07c6643
target=esp32s3
# Where the legs restore and save them (kit-firmware.yml); tests point them elsewhere.
export IDF_PATH="${IDF_PATH:-/home/runner/esp-idf}"
export IDF_TOOLS_PATH="${IDF_TOOLS_PATH:-/home/runner/.espressif}"
receipt="$IDF_TOOLS_PATH/iterate-esp-idf.receipt"
# Any edit here (the pin, the target, the install) makes an older install stale, and so does another
# python3: the install's Python environment (python_env/idf6.1_py3.X_env) runs on the one it was
# built with.
key="esp-idf-$(git hash-object "${BASH_SOURCE[0]}")-python$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"

install_esp_idf() {
  rm -rf "$IDF_PATH" "$IDF_TOOLS_PATH"
  # Shallow submodules as ESP-IDF's own image clones (tools/docker/Dockerfile, IDF_CLONE_SHALLOW).
  git clone --depth 1 --recursive --shallow-submodules --branch "$version" \
    https://github.com/espressif/esp-idf.git "$IDF_PATH"
  test "$(git -C "$IDF_PATH" rev-parse HEAD)" = "$commit"
  "$IDF_PATH/install.sh" "$target"
  # The downloaded tool archives, already unpacked under $IDF_TOOLS_PATH/tools.
  rm -rf "$IDF_TOOLS_PATH/dist"
  echo "$key" >"$receipt"
}

case "${1:-}" in
  key)
    echo "key=$key"
    ;;
  ensure)
    found="$(cat "$receipt" 2>/dev/null || echo none)"
    if [ "$found" = "$key" ]; then
      echo "Using ESP-IDF $version from Depot Cache ($IDF_PATH, $IDF_TOOLS_PATH); nothing to download."
    else
      echo "::warning::No ESP-IDF from Depot Cache for $key (the receipt restored: $found), so this leg installs ESP-IDF $version from the network. A main run's legs save it."
      install_esp_idf
    fi
    if [ -n "${GITHUB_ENV:-}" ]; then
      printf 'IDF_PATH=%s\nIDF_TOOLS_PATH=%s\n' "$IDF_PATH" "$IDF_TOOLS_PATH" >>"$GITHUB_ENV"
    fi
    ;;
  *)
    echo "usage: $0 key|ensure" >&2
    exit 2
    ;;
esac
