#!/usr/bin/env bash
# Batch FBX -> GLB via headless Blender (scripts/fbx-to-gltf.py).
# Usage: bash scripts/convert-fbx.sh <out-dir> <src-dir-or-fbx> [more...]
#   BLENDER env var overrides the Blender binary path.
set -euo pipefail

BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$1"; shift
mkdir -p "$OUT"

n=0
for src in "$@"; do
  if [ -d "$src" ]; then fbxs=("$src"/*.fbx); else fbxs=("$src"); fi
  for fbx in "${fbxs[@]}"; do
    [ -e "$fbx" ] || continue
    name="$(basename "$fbx" .fbx)"
    if "$BLENDER" -b -P "$HERE/fbx-to-gltf.py" -- "$fbx" "$OUT/$name.glb" 2>&1 | grep -i "fbx-to-gltf"; then
      n=$((n + 1))
    else
      echo "  FAILED: $name"
    fi
  done
done
echo "converted $n FBX -> $OUT"
