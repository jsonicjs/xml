#!/usr/bin/env bash
# Download the W3C XML Conformance Test Suite (xmlts, 2013-09-23
# snapshot) and extract it into test/xmlconf/ so both the Go and
# TypeScript test runners can exercise the parser against thousands
# of real-world XML documents.
#
# The archive is owned by W3C and its contributors (Sun, OASIS, IBM,
# University of Edinburgh, Fuji Xerox, ...) and is not redistributed
# as part of this repository. Running this script is an explicit
# opt-in to download it from the W3C site.
#
# Usage:
#   scripts/fetch-xml-suite.sh            # default location
#   scripts/fetch-xml-suite.sh /some/dir  # custom destination
#
# After fetching, the conformance-driven tests are picked up
# automatically:
#   go test ./go/...
#   npm test
set -euo pipefail

URL="https://www.w3.org/XML/Test/xmlts20130923.tar.gz"

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$REPO_ROOT/test/xmlconf}"

if [ -d "$DEST" ] && [ -d "$DEST/xmltest" ]; then
  echo "Suite already present at $DEST (delete the directory to re-download)."
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Fetching $URL ..."
curl -fL -o "$tmp/xmlts.tar.gz" "$URL"

echo "Extracting to $DEST ..."
mkdir -p "$DEST"
# The archive already contains a top-level `xmlconf/` directory, so
# strip one component to land its contents directly in $DEST.
tar -xzf "$tmp/xmlts.tar.gz" -C "$DEST" --strip-components=1

valid=$(find "$DEST/xmltest/valid/sa" -maxdepth 1 -name '*.xml' | wc -l)
notwf=$(find "$DEST/xmltest/not-wf/sa" -maxdepth 1 -name '*.xml' | wc -l)
echo "Done. Extracted $valid standalone-valid and $notwf not-well-formed XML files."
