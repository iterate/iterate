#!/usr/bin/env bash
# THE TOOLCHAIN ON DEPOT'S STOCK IMAGE (docs/depot-ci.md#setup-on-depots-stock-image): Node, pnpm
# and the Doppler CLI, each at the version this checkout declares. Plain shell.
#
#   bash scripts/ci/toolchain.sh node    Node alone, on the PATH ($GITHUB_PATH): Kit Firmware's jobs.
#   bash scripts/ci/toolchain.sh start   Node, then pnpm and the Doppler CLI fetched in the background,
#                                        so the fetch overlaps the restore of pnpm's store
#                                        (.depot/actions/setup).
#   bash scripts/ci/toolchain.sh wait    Waits for that fetch (≤ 2 min); fails with its log if it failed.
#
# - Node: .nvmrc's version, from the stock image's tool cache (/opt/hostedtoolcache/node, which
#   setup-node never reads: Depot points it at an empty one). An image without it gets a warning,
#   and Node from nodejs.org, checked against the release's SHASUMS256.txt.
# - pnpm: the root package.json's `packageManager`, fetched by Node's corepack, which checks the npm
#   registry's signature. `pnpm` runs that version in every directory: corepack's own shim would run
#   its latest pnpm outside the repo (the preview deploy's wrangler install in a tmpdir).
# - The Doppler CLI: DOPPLER_CLI_VERSION's release, checked against DOPPLER_CLI_SHA256.
set -euo pipefail
# and inside $(…), which bash otherwise runs without -e
shopt -s inherit_errexit

DOPPLER_CLI_VERSION=3.76.6
DOPPLER_CLI_SHA256=67e4e020761adf3ffe5a030712d61721b4e2752182670bf90de5a2a88e4961e3
# Where Node comes from; the tests point these at fixtures.
node_cache="${TOOLCHAIN_NODE_CACHE:-/opt/hostedtoolcache/node}"
node_dist="${TOOLCHAIN_NODE_DIST:-https://nodejs.org/dist}"
tools="${RUNNER_TEMP:?}/toolchain"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# The newest Node in the image's tool cache that .nvmrc's version (a major, or an exact version)
# names, else Node from nodejs.org. Prints its bin directory.
node_bin() {
  local want dir version found=""
  want="$(tr -d '[:space:]' <.nvmrc)"
  want="${want#v}"
  for dir in $(ls -d "$node_cache"/*/x64 2>/dev/null | sort -V); do
    version="${dir#"$node_cache"/}"
    version="${version%/x64}"
    case "$version" in "$want" | "$want".*) [ -x "$dir/bin/node" ] && found="$dir/bin" ;; esac
  done
  if [ -n "$found" ]; then
    echo "$found"
    return
  fi
  echo "::warning title=Node from nodejs.org::Depot's stock image has no Node $want in $node_cache, so this job downloads it from nodejs.org" >&2
  local release="latest-v$want.x" line
  case "$want" in *.*) release="v$want" ;; esac
  line="$(curl -fsSL --retry 3 "$node_dist/$release/SHASUMS256.txt" | grep -E ' node-v[0-9.]+-linux-x64\.tar\.xz$')"
  mkdir -p "$tools/node"
  curl -fsSL --retry 3 -o "$tools/node.tar.xz" "$node_dist/$release/${line##* }"
  echo "${line%% *}  $tools/node.tar.xz" | sha256sum --check --quiet >&2
  tar -xJf "$tools/node.tar.xz" -C "$tools/node" --strip-components 1
  rm "$tools/node.tar.xz"
  echo "$tools/node/bin"
}

mkdir -p "$tools"
case "${1:-}" in
  node)
    bin="$(node_bin)"
    echo "$bin" >>"$GITHUB_PATH"
    echo "Node $("$bin/node" --version) from $bin"
    ;;
  start)
    bin="$(node_bin)"
    printf '%s\n%s\n' "$bin" "$tools" >>"$GITHUB_PATH"
    export PATH="$tools:$bin:$PATH"
    echo "Node $(node --version) from $bin"
    pnpm_version="$(node -p 'require("./package.json").packageManager.replace(/^pnpm@/, "")')"
    printf '#!/bin/sh\nCOREPACK_ENABLE_DOWNLOAD_PROMPT=0 exec "%s/corepack" "pnpm@%s" "$@"\n' \
      "$bin" "$pnpm_version" >"$tools/pnpm"
    chmod +x "$tools/pnpm"
    # Detached, so this step ends now; `wait` reads the fetch's exit status.
    nohup bash -c 'bash "$0" fetch; echo $? >"$1/fetch.exit"' "${BASH_SOURCE[0]}" "$tools" \
      >"$tools/fetch.log" 2>&1 </dev/null &
    ;;
  # start's background half: pnpm, then the Doppler CLI, into $tools
  fetch)
    corepack install
    curl -fsSL --retry 3 -o "$tools/doppler.tar.gz" \
      "https://github.com/DopplerHQ/cli/releases/download/${DOPPLER_CLI_VERSION}/doppler_${DOPPLER_CLI_VERSION}_linux_amd64.tar.gz"
    echo "${DOPPLER_CLI_SHA256}  $tools/doppler.tar.gz" | sha256sum --check --quiet
    tar -xzf "$tools/doppler.tar.gz" -C "$tools" doppler
    rm "$tools/doppler.tar.gz"
    echo "pnpm $(pnpm --version), $(doppler --version)"
    ;;
  wait)
    for _ in $(seq 1200); do
      [ -e "$tools/fetch.exit" ] && break
      sleep 0.1
    done
    cat "$tools/fetch.log"
    if [ "$(cat "$tools/fetch.exit" 2>/dev/null)" != 0 ]; then
      echo "::error title=Toolchain::pnpm or the Doppler CLI did not install; the fetch's log is above"
      exit 1
    fi
    ;;
  *)
    echo "usage: $0 node|start|wait" >&2
    exit 2
    ;;
esac
