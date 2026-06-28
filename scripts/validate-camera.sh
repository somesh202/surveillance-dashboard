#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
HLS_URL="${HLS_URL:-http://localhost:8888}"
USERNAME="${USERNAME:-demo}"
PASSWORD="${PASSWORD:-demo1234}"
CAMERA_NAME="${CAMERA_NAME:-Validation Camera}"
RTSP_URL="${RTSP_URL:-rtsp://mediamtx:8554/sample}"
LOCATION="${LOCATION:-Validation}"
WAIT_SECONDS="${WAIT_SECONDS:-25}"
EXPECT_REAL_PERSON="${EXPECT_REAL_PERSON:-false}"
EXPECT_ALERTS="${EXPECT_ALERTS:-$EXPECT_REAL_PERSON}"

json_get() {
  python3 -c 'import json,sys; data=json.load(sys.stdin); cur=data
for key in sys.argv[1].split("."):
    if key.isdigit(): cur=cur[int(key)]
    else: cur=cur[key]
print(cur)' "$1"
}

request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "$API_URL$path" -H "Content-Type: application/json" -H "Authorization: Bearer ${TOKEN:-}" -d "$body"
  else
    curl -fsS -X "$method" "$API_URL$path" -H "Authorization: Bearer ${TOKEN:-}"
  fi
}

echo "== API health =="
curl -fsS "$API_URL/health"
echo

echo "== Auth =="
set +e
signup_response=$(curl -sS -X POST "$API_URL/auth/signup" -H "Content-Type: application/json" -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")
set -e
login_response=$(curl -fsS -X POST "$API_URL/auth/login" -H "Content-Type: application/json" -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")
TOKEN=$(printf '%s' "$login_response" | json_get token)
echo "logged in as $USERNAME"

echo "== Create camera =="
create_response=$(request POST /cameras "{\"name\":\"$CAMERA_NAME\",\"rtspUrl\":\"$RTSP_URL\",\"location\":\"$LOCATION\",\"enabled\":true}")
CAMERA_ID=$(printf '%s' "$create_response" | json_get camera.id)
STREAM_PATH=$(printf '%s' "$create_response" | json_get camera.streamPath)
echo "cameraId=$CAMERA_ID"
echo "streamPath=$STREAM_PATH"

echo "== Start camera =="
request POST "/cameras/$CAMERA_ID/start" >/dev/null
echo "waiting ${WAIT_SECONDS}s for worker, MediaMTX, and detector..."
sleep "$WAIT_SECONDS"

echo "== Camera API state =="
camera_response=$(request GET "/cameras/$CAMERA_ID")
printf '%s\n' "$camera_response" | python3 -m json.tool
state=$(printf '%s' "$camera_response" | json_get camera.state)
fps=$(printf '%s' "$camera_response" | json_get camera.fps)
echo "state=$state fps=$fps"

if [[ "$state" != "live" ]]; then
  echo "ERROR: expected camera state live, got $state" >&2
  exit 1
fi

echo "== HLS live manifest check =="
manifest_url="$HLS_URL/$STREAM_PATH/index.m3u8?cookieCheck=1"
echo "$manifest_url"
curl -fsS "$manifest_url" | head -20

echo "== Alerts API check =="
alerts_response=$(request GET "/alerts?cameraId=$CAMERA_ID&pageSize=10")
printf '%s\n' "$alerts_response" | python3 -m json.tool
alert_count=$(printf '%s' "$alerts_response" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["alerts"]))')
echo "alert_count=$alert_count"

if [[ "$EXPECT_ALERTS" == "true" && "$alert_count" == "0" ]]; then
  echo "ERROR: expected at least one alert" >&2
  exit 1
fi

real_count=$(printf '%s' "$alerts_response" | python3 -c 'import json,sys; data=json.load(sys.stdin)["alerts"]; print(sum(1 for a in data if a.get("metadata", {}).get("simulatedFallback") is False))')
sim_count=$(printf '%s' "$alerts_response" | python3 -c 'import json,sys; data=json.load(sys.stdin)["alerts"]; print(sum(1 for a in data if a.get("metadata", {}).get("simulatedFallback") is True))')
echo "real_yolo_alerts=$real_count simulated_alerts=$sim_count"

if [[ "$EXPECT_REAL_PERSON" == "true" && "$real_count" == "0" ]]; then
  echo "ERROR: expected real YOLO person alert with simulatedFallback=false" >&2
  echo "Use RTSP_URL=rtsp://mediamtx:8554/person-demo after starting person-video-camera or person-image-camera." >&2
  exit 1
fi

echo "== Stop camera =="
request POST "/cameras/$CAMERA_ID/stop" >/dev/null

echo "OK"
