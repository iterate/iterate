#!/usr/bin/env bash
set -euo pipefail

PROJECT=/opt/iterate
TARGET=/var/local-node-modules

echo "========================================"
echo " pnpm + symlinked node_modules demo"
echo "========================================"
echo ""

# ── Step 1: Baseline — normal pnpm install ────────────────────────
echo "── Step 1: Normal pnpm install (baseline) ──"
cd "$PROJECT"
pnpm install --no-frozen-lockfile 2>&1
echo ""
echo "✓ Baseline pnpm install succeeded."
echo "  node_modules is a real directory:"
ls -ld node_modules
echo ""

# ── Step 2: Clean up ──────────────────────────────────────────────
echo "── Step 2: Remove node_modules ──"
rm -rf node_modules
echo "  Removed node_modules."
echo ""

# ── Step 3: Create symlink ────────────────────────────────────────
echo "── Step 3: Symlink node_modules -> $TARGET ──"
ln -s "$TARGET" "$PROJECT/node_modules"
echo "  Created symlink:"
ls -ld node_modules
echo ""
echo "  Target directory exists and is writable:"
ls -ld "$TARGET"
echo ""

# ── Step 4: Attempt pnpm install through the symlink ──────────────
echo "── Step 4: pnpm install with symlinked node_modules ──"
echo ""

set +e
OUTPUT=$(pnpm install --no-frozen-lockfile 2>&1)
EXIT_CODE=$?
set -e

echo "$OUTPUT"
echo ""
echo "  Exit code: $EXIT_CODE"
echo ""

# ── Step 5: Verdict ───────────────────────────────────────────────
echo "========================================"
if [ $EXIT_CODE -ne 0 ]; then
  echo " PROVED: pnpm rejects symlinked node_modules"
  echo ""
  echo " pnpm install works with a real directory but fails"
  echo " when node_modules is a symlink to another directory."
  echo ""
  if echo "$OUTPUT" | grep -qi "ENOTDIR\|EEXIST\|not a directory"; then
    echo " Error type: pnpm calls mkdir on node_modules and"
    echo " gets ENOTDIR/EEXIST because it's a symlink, not a dir."
  else
    echo " (Error didn't contain ENOTDIR/EEXIST — check output above)"
  fi
else
  echo " UNEXPECTED: pnpm install succeeded with symlinked node_modules."
  echo " The hypothesis may not hold for this pnpm version."
fi
echo "========================================"
