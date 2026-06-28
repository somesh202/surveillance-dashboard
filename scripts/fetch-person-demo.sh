#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_FILE="${OUT_FILE:-$ROOT_DIR/demo/person.jpg}"
SOURCE_URL="${SOURCE_URL:-https://ultralytics.com/images/bus.jpg}"

mkdir -p "$(dirname "$OUT_FILE")"

echo "Downloading person demo image from: $SOURCE_URL"
if command -v curl >/dev/null 2>&1; then
  curl -L --fail --retry 3 --output "$OUT_FILE" "$SOURCE_URL"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$OUT_FILE" "$SOURCE_URL"
else
  python3 - "$SOURCE_URL" "$OUT_FILE" <<'PY'
import sys
import urllib.request

url, out = sys.argv[1], sys.argv[2]
urllib.request.urlretrieve(url, out)
PY
fi

echo "Saved: $OUT_FILE"
echo "Start the RTSP demo with: docker compose --profile person-image-demo up -d person-image-camera"
