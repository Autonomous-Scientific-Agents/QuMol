#!/usr/bin/env bash
# Download the pinned front-end libraries into web/vendor/ and verify their checksums.
# The game is served together with these files from our own origin, so no third-party
# CDN can change the code that runs next to players' login tokens.
set -euo pipefail

THREE_VER=0.160.0
THREE_SHA=1ee2f935c4f555814b388e87b5ef78a44856bd2e9d0feb88643a6e193fb42856
RDKIT_VER=2026.9.1
RDKIT_SHA=ae6b0e42b85114a2f38ef890fcb229a90b54b0b42d4636c50ae1c7f77d85ffe0

DEST="$(cd "$(dirname "$0")/.." && pwd)/web/vendor"
STAMP="$DEST/.versions"
WANT="three-$THREE_VER rdkit-$RDKIT_VER"
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$WANT" ]; then
  echo "vendor libraries up to date ($WANT)"; exit 0
fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
get() {  # url sha256 file
  curl -fsSL --retry 3 "$1" -o "$tmp/$3"
  echo "$2  $tmp/$3" | sha256sum -c --quiet - || { echo "!! checksum mismatch for $1" >&2; exit 1; }
}
get "https://registry.npmjs.org/three/-/three-$THREE_VER.tgz" "$THREE_SHA" three.tgz
get "https://registry.npmjs.org/@rdkit/rdkit/-/rdkit-$RDKIT_VER.tgz" "$RDKIT_SHA" rdkit.tgz

mkdir -p "$tmp/three" "$tmp/rdkit" "$DEST"
tar -xzf "$tmp/three.tgz" -C "$tmp/three" package/build/three.module.js package/examples/jsm/controls/OrbitControls.js
tar -xzf "$tmp/rdkit.tgz" -C "$tmp/rdkit" package/dist/RDKit_minimal.js package/dist/RDKit_minimal.wasm

cp "$tmp/three/package/build/three.module.js" "$DEST/"
# OrbitControls imports the bare specifier 'three'; point it at the local file instead.
sed "s#from 'three'#from './three.module.js'#" "$tmp/three/package/examples/jsm/controls/OrbitControls.js" > "$DEST/OrbitControls.js"
cp "$tmp/rdkit/package/dist/RDKit_minimal.js" "$tmp/rdkit/package/dist/RDKit_minimal.wasm" "$DEST/"
echo "$WANT" > "$STAMP"
echo "vendor libraries installed in $DEST ($WANT)"
