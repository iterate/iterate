#!/usr/bin/env bash
set -euo pipefail

# Keep CI independent from cli.doppler.com's unpinned latest-version resolver.
# The checksum is published in the matching Doppler GitHub release.
readonly version="3.76.0"
readonly archive="doppler_${version}_linux_amd64.tar.gz"
readonly sha256="04f1ff30ed162d7af1dba7f11ad6a37ef35099de86a7ec6e261b64b1b337a3f3"
readonly release_url="https://github.com/DopplerHQ/cli/releases/download/${version}/${archive}"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "error: the pinned Doppler CI installer supports only Linux x86_64" >&2
  exit 1
fi

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

archive_path="${temp_dir}/${archive}"
curl \
  --connect-timeout 10 \
  --fail \
  --location \
  --max-time 60 \
  --proto '=https' \
  --retry 3 \
  --retry-all-errors \
  --retry-delay 2 \
  --retry-max-time 90 \
  --show-error \
  --silent \
  --tlsv1.2 \
  --output "$archive_path" \
  "$release_url"

printf '%s  %s\n' "$sha256" "$archive_path" | sha256sum --check --status
tar --extract --gzip --file "$archive_path" --directory "$temp_dir" doppler

if [[ "${EUID}" -eq 0 || -w /usr/local/bin ]]; then
  install -m 0755 "${temp_dir}/doppler" /usr/local/bin/doppler
elif command -v sudo >/dev/null 2>&1; then
  sudo install -m 0755 "${temp_dir}/doppler" /usr/local/bin/doppler
else
  echo "error: need permission to install Doppler at /usr/local/bin/doppler" >&2
  exit 1
fi

doppler --version
