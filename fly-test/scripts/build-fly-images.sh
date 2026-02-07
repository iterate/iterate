#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLY_TEST_DIR="$ROOT_DIR/fly-test"
SHA_SHORT="$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
TAG_SUFFIX="${SHA_SHORT}-$(date -u +%m%d%H%M%S)"
REGISTRY="${FLY_TEST_IMAGE_REGISTRY:-fly}"
PLATFORM="${FLY_TEST_IMAGE_PLATFORM:-linux/amd64}"

if [ "$REGISTRY" = "fly" ]; then
  FLY_TOKEN="${FLY_API_TOKEN:-${FLY_API_KEY:-}}"
  if [ -z "$FLY_TOKEN" ]; then
    echo "FLY_API_KEY or FLY_API_TOKEN required for FLY_TEST_IMAGE_REGISTRY=fly" >&2
    exit 1
  fi
  FLY_APP="${FLY_TEST_IMAGE_APP:-iterate-node-egress-runtime}"
  FLY_ORG="${FLY_ORG:-iterate}"

  export FLY_API_TOKEN="$FLY_TOKEN"
  flyctl apps create "$FLY_APP" -o "$FLY_ORG" -y >/dev/null 2>&1 || true
  flyctl auth docker -t "$FLY_TOKEN" >/dev/null

  EGRESS_IMAGE="registry.fly.io/${FLY_APP}:egress-${TAG_SUFFIX}"
  SANDBOX_IMAGE="registry.fly.io/${FLY_APP}:sandbox-${TAG_SUFFIX}"
elif [ "$REGISTRY" = "depot" ]; then
  PROJECT_ID="${DEPOT_PROJECT_ID:-}"
  if [ -z "$PROJECT_ID" ]; then
    echo "DEPOT_PROJECT_ID is required for FLY_TEST_IMAGE_REGISTRY=depot" >&2
    exit 1
  fi
  EGRESS_IMAGE="registry.depot.dev/${PROJECT_ID}:fly-test-egress-${TAG_SUFFIX}"
  SANDBOX_IMAGE="registry.depot.dev/${PROJECT_ID}:fly-test-sandbox-${TAG_SUFFIX}"
else
  echo "FLY_TEST_IMAGE_REGISTRY must be 'fly' or 'depot'" >&2
  exit 1
fi

cd "$FLY_TEST_DIR"

echo "Building egress image: $EGRESS_IMAGE"
depot build --platform "$PLATFORM" --progress=plain --push -t "$EGRESS_IMAGE" -f docker/egress.Dockerfile .

echo "Building sandbox image: $SANDBOX_IMAGE"
depot build --platform "$PLATFORM" --progress=plain --push -t "$SANDBOX_IMAGE" -f docker/sandbox.Dockerfile .

mkdir -p .cache
echo "$EGRESS_IMAGE" > .cache/egress-image.txt
echo "$SANDBOX_IMAGE" > .cache/sandbox-image.txt

echo "Saved: .cache/egress-image.txt"
echo "Saved: .cache/sandbox-image.txt"
echo "egress_image=$EGRESS_IMAGE"
echo "sandbox_image=$SANDBOX_IMAGE"
