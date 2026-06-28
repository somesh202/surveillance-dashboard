# Real-Time Camera Surveillance Dashboard

A Dockerized Video Management System for the Skylark Labs assignment. Users can sign up, register RTSP cameras, start/stop processing, view live browser playback over MediaMTX WebRTC, and receive real-time person detection alerts.

## Stack

- Frontend: React, TypeScript, Vite, CSS dashboard UI
- Backend: Bun, Hono, PostgreSQL, JWT, Redis Streams, WebSocket
- Worker: Python, FFmpeg, OpenCV, Ultralytics YOLOv8n
- Media: MediaMTX for RTSP ingest and WebRTC playback
- Infra: Docker Compose

## Architecture

```text
React Dashboard
  | REST + WebSocket
  v
Bun/Hono API ---- PostgreSQL
  | Redis Streams camera.commands
  v
Python Worker ---- FFmpeg/OpenCV/YOLOv8n
  | publishes camera.alerts queue + RTSP relay
  v                         v
Bun/Hono API <--------- MediaMTX ---- WebRTC/WHEP playback in camera tile
```

The backend owns auth, camera CRUD, persisted alerts, WebSocket fanout, and user scoping. Redis Streams decouples start/stop commands from the worker through `camera.commands`, and detector alerts return through `camera.alerts` before being persisted and broadcast. The worker runs one independent camera thread per stream, so one failing camera does not stop others.

## Requirements from you

Install:

- Docker
- Docker Compose
- Git
- Internet access for first build, Docker images, npm packages, Python packages, and YOLO weights

You do not need a real RTSP camera. Compose includes a generated FFmpeg test stream published to MediaMTX.

## Run

```bash
cp .env.example .env
docker compose up --build
```

Open:

```text
http://localhost:5173
```

Create an account from the signup screen. The validation script uses this local test account:

```text
username: operator
password: operator2026
```

## Add the sample camera

Use the prefilled form in the dashboard, or enter:

```text
Name: Lobby Camera
RTSP URL: rtsp://mediamtx:8554/sample
Location: Main Lobby
```

Press **Start**. The backend sends a `camera.start` command to Redis. The worker relays the RTSP stream into a per-camera MediaMTX path and starts detection. The dashboard plays the stream with WebRTC/WHEP first and falls back to HLS only if WebRTC cannot start in the local browser.

The built-in sample stream is an FFmpeg test pattern, so it has no real person in frame. Simulated alerts are disabled by default for submission. If you intentionally want fake fallback alerts for UI-only demos, set `DEMO_ALERTS_WHEN_NO_PERSON=true`. Real RTSP streams with people use YOLO detections directly and produce alerts with `simulatedFallback: false`.

## Validate real person detection

The default sample camera cannot prove real person detection because it contains no person. To validate YOLO detection with `simulatedFallback: false`, provide local media containing a visible person.

Quick path, download a public YOLO demo image with people:

```bash
./scripts/fetch-person-demo.sh
docker compose --profile person-image-demo up -d person-image-camera
```

Option A, use a video:

```bash
mkdir -p demo
cp /path/to/video-with-person.mp4 demo/person.mp4
docker compose --profile person-demo up -d person-video-camera
```

Option B, use your own still image:

```bash
mkdir -p demo
cp /path/to/image-with-person.jpg demo/person.jpg
docker compose --profile person-image-demo up -d person-image-camera
```

Then add a camera in the dashboard:

```text
Name: Person Demo
RTSP URL: rtsp://mediamtx:8554/person-demo
Location: Local Demo
```

Press **Start**. Wait for alerts, then verify they are real model detections:

```bash
docker compose exec postgres psql -U surveillance -d surveillance -c "select confidence, metadata from alerts order by created_at desc limit 5;"
```

Real detections show:

```json
"simulatedFallback": false
```

Fallback/demo alerts show:

```json
"simulatedFallback": true
```

## Validation APIs and script

You can validate the system without opening the UI.

Run the default fake-camera validation:

```bash
./scripts/validate-camera.sh
```

This checks:

- backend health: `GET /health`
- auth: `POST /auth/signup`, `POST /auth/login`
- camera create/start/state: `POST /cameras`, `POST /cameras/:id/start`, `GET /cameras/:id`
- live stream availability through MediaMTX WebRTC URL and HLS manifest
- alerts API: `GET /alerts?cameraId=...`

For real person detection, first start one of the `person-demo` streams above, then run:

```bash
RTSP_URL=rtsp://mediamtx:8554/person-demo EXPECT_REAL_PERSON=true ./scripts/validate-camera.sh
```

The script passes real detection only if at least one alert has:

```json
"simulatedFallback": false
```

Manual API checks:

```bash
TOKEN=$(curl -s http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"operator","password":"operator2026"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

curl -s http://localhost:3001/cameras \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

curl -s 'http://localhost:3001/alerts?pageSize=10' \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Live stream checks:

```bash
# HLS fallback manifest used only if WebRTC cannot start
curl -s 'http://localhost:8888/<streamPath>/index.m3u8?cookieCheck=1'

# MediaMTX WebRTC page for the same stream
open 'http://localhost:8889/<streamPath>'
```

## Service URLs

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001
- MediaMTX WebRTC: http://localhost:8889
- MediaMTX RTSP: rtsp://localhost:8554
- Postgres: internal Docker network only (`postgres:5432`); use `docker compose exec postgres psql ...` for inspection
- Redis: localhost:6379

## Event format

The alert payload is intentionally identical across worker, API, DB mapping, WebSocket, and frontend.

```json
{
  "id": "uuid",
  "type": "person_detected",
  "cameraId": "uuid",
  "userId": "uuid",
  "timestamp": "2026-06-27T10:15:30.000Z",
  "confidence": 0.87,
  "label": "person",
  "bbox": {
    "x": 120,
    "y": 80,
    "width": 220,
    "height": 420
  },
  "frameWidth": 1280,
  "frameHeight": 720,
  "trackId": null,
  "snapshotUrl": null,
  "metadata": {
    "model": "yolov8n.pt",
    "source": "worker-xxxx",
    "simulatedFallback": false
  }
}
```

WebSocket envelope:

```json
{
  "type": "alert.created",
  "cameraId": "uuid",
  "payload": {}
}
```

Other WebSocket event types:

- `camera.state`
- `camera.stats`
- `alert.created`
- `connected`

Camera states:

- `stopped`
- `starting`
- `connecting`
- `live`
- `stopping`
- `error`

## API summary

Auth:

- `POST /auth/signup`
- `POST /auth/login`
- `GET /auth/me`

Cameras, all protected by JWT:

- `GET /cameras`
- `POST /cameras`
- `GET /cameras/:id`
- `PATCH /cameras/:id`
- `DELETE /cameras/:id`
- `POST /cameras/:id/start`
- `POST /cameras/:id/stop`

Alerts:

- `GET /alerts?cameraId=&from=&to=&page=&pageSize=`

Internal worker endpoints, protected by `x-worker-token`:

- `POST /internal/alerts`
- `POST /internal/state`
- `POST /internal/stats`

Realtime:

- `GET /ws?token=<JWT>`

## Detection model

This project uses `YOLOv8n` from Ultralytics.

Why:

- Open source and widely used
- Detects the COCO `person` class out of the box
- Lightweight enough for CPU demo use
- Easy to swap for a larger YOLO model or an ONNX/TensorRT model later

The worker filters detections to class `0`, which is `person` in COCO.

## Alert deduplication and rate limiting

The worker emits at most one person alert per camera every `ALERT_COOLDOWN_SECONDS`, default `10`. It still publishes live FPS and detections-per-minute stats.

## Message queues

Redis Streams are used as the message queue layer:

- `camera.commands`: backend enqueues `camera.start` and `camera.stop`; worker consumer group processes camera lifecycle commands.
- `camera.alerts`: worker enqueues YOLO `person_detected` events; backend consumer group persists alerts to PostgreSQL and broadcasts them over WebSocket.

This keeps media/detection work decoupled from API request handling and makes worker/backend restarts safer than direct in-process calls.

## Notes on WebRTC

The dashboard attempts native WebRTC playback first through MediaMTX WHEP. The worker publishes/relays RTSP to a camera-specific MediaMTX path; MediaMTX exposes that path over WebRTC at:

```text
http://localhost:8889/<streamPath>
```

The frontend tile uses the WHEP endpoint at `http://localhost:8889/<streamPath>/whep`. If local browser/network ICE setup fails, the tile falls back to HLS at `http://localhost:8888/<streamPath>/index.m3u8?cookieCheck=1` and labels the tile as `HLS fallback`.

## Assignment compliance checklist

- Real-time surveillance dashboard: implemented with multi-camera cards, live state, FPS, detections/minute, and recent alerts.
- User authentication: implemented with signup/login, JWT-protected camera and alert APIs, and user-scoped data.
- Camera management: implemented create, list, edit, delete, start, and stop APIs/UI for RTSP cameras.
- WebRTC playback: implemented as the primary frontend path through MediaMTX WHEP; HLS exists only as a labelled fallback.
- Person detection: implemented in the worker with YOLOv8n COCO `person` class filtering and real alert metadata.
- Real-time alerts: implemented through persisted Postgres alerts plus WebSocket fanout to the dashboard.
- Queue/worker architecture: Redis Streams decouple backend start/stop commands (`camera.commands`) and detector alerts (`camera.alerts`).
- Containerized run: Docker Compose starts Postgres, Redis, MediaMTX, backend, worker, frontend, and demo camera sources.
- Validation evidence: `./scripts/validate-camera.sh` validates the default stream, and `EXPECT_REAL_PERSON=true` validates real non-simulated YOLO alerts.

## Known limitations

- The default `sample` stream is a generated color-bar test pattern, not a real CCTV camera.
- Real person detection requires a real RTSP camera, a public RTSP stream with people, or the local `person-demo` profile.
- Simulated no-person alerts are disabled by default. If enabled, they are explicitly marked with `simulatedFallback: true`.
- The dashboard is WebRTC-first, but includes HLS fallback for local browser stability.

## Scaling design

For a larger deployment:

- Run many worker replicas with Redis Stream consumer groups
- Partition commands by camera ID or tenant
- Move snapshots to S3-compatible object storage
- Add GPU workers for YOLO inference
- Add Prometheus metrics for active cameras, FPS, and alert latency
- Move WebRTC media to dedicated MediaMTX/SFU nodes
- Add persistent command/event audit streams

## Future improvements

- TURN server support for WebRTC across restrictive networks
- Refresh-token auth with HTTP-only cookies
- Kubernetes manifests and autoscaling
- Snapshot capture for each alert
- Model warm pool and GPU acceleration
- Better person tracking to deduplicate by track ID
- End-to-end Playwright tests
