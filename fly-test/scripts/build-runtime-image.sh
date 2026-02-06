#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA_SHORT="$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
TAG="fly-test-runtime-${SHA_SHORT}-$(date -u +%m%d%H%M%S)"
REGISTRY="${RUNTIME_IMAGE_REGISTRY:-fly}"
PLATFORM="${RUNTIME_IMAGE_PLATFORM:-linux/amd64}"

if [ "$REGISTRY" = "fly" ]; then
  FLY_TOKEN="${FLY_API_TOKEN:-${FLY_API_KEY:-}}"
  if [ -z "$FLY_TOKEN" ]; then
    echo "FLY_API_KEY or FLY_API_TOKEN is required for RUNTIME_IMAGE_REGISTRY=fly" >&2
    exit 1
  fi

  RUNTIME_APP="${FLY_TEST_RUNTIME_APP:-iterate-node-egress-runtime}"
  FLY_ORG="${FLY_ORG:-iterate}"

  export FLY_API_TOKEN="$FLY_TOKEN"
  flyctl apps create "$RUNTIME_APP" -o "$FLY_ORG" -y >/dev/null 2>&1 || true
  flyctl auth docker -t "$FLY_TOKEN" >/dev/null
  IMAGE="registry.fly.io/${RUNTIME_APP}:${TAG}"
elif [ "$REGISTRY" = "depot" ]; then
  PROJECT_ID="${DEPOT_PROJECT_ID:-}"
  if [ -z "$PROJECT_ID" ]; then
    echo "DEPOT_PROJECT_ID is required for RUNTIME_IMAGE_REGISTRY=depot" >&2
    exit 1
  fi
  IMAGE="registry.depot.dev/${PROJECT_ID}:${TAG}"
else
  echo "RUNTIME_IMAGE_REGISTRY must be 'fly' or 'depot'" >&2
  exit 1
fi

cd "$ROOT_DIR"

echo "Building and pushing: $IMAGE (platform=$PLATFORM)"
depot build --platform "$PLATFORM" --progress=plain --push -t "$IMAGE" -f fly-test/runtime-image.Dockerfile .

mkdir -p fly-test/.cache
echo "$IMAGE" > fly-test/.cache/runtime-image.txt
echo "Saved image ref to fly-test/.cache/runtime-image.txt"
echo "image=$IMAGE"
