# Submission Guide: Real-Time Camera Surveillance Dashboard

This document explains the project end-to-end so you can confidently submit it and answer technical questions about the stack, architecture, WebRTC, Bun, queues, and person detection.

## 1. One-minute project explanation

This project is a Dockerized real-time camera surveillance dashboard. A user can sign up, add RTSP camera streams, start or stop processing, watch the live stream in the browser, and receive real-time person-detection alerts.

The backend is written with Bun and Hono. It manages authentication, camera CRUD, runtime camera state, alerts, WebSocket events, and Redis Streams queues. A Python worker listens for camera start/stop commands, uses FFmpeg to relay RTSP streams into MediaMTX, runs YOLOv8n person detection with OpenCV frames, and publishes alert events through a Redis Stream. MediaMTX converts RTSP streams into browser-playable WebRTC/WHEP streams. The frontend is a React dashboard that uses WebRTC first and HLS as fallback.

## 2. What the assignment asked for

The assignment was to build a real-time camera surveillance dashboard with person detection and WebRTC playback.

This project covers:

- User authentication.
- Camera add/list/edit/delete/start/stop.
- RTSP camera ingestion.
- WebRTC live browser playback.
- Real person detection using YOLOv8n.
- Real-time alerts.
- Message queues using Redis Streams.
- Persistent data using PostgreSQL.
- Dockerized run using Docker Compose.
- Validation scripts for normal stream and real person detection.

## 3. Main services

### Frontend

Path: `apps/frontend`

Technology:

- React
- TypeScript
- Vite
- hls.js for fallback playback

Responsibilities:

- Login/signup UI.
- Camera form.
- Camera tiles.
- Start/stop buttons.
- Live video player.
- FPS and detections/minute display.
- Recent alert list.
- WebSocket subscription for live updates.

Important file:

- `apps/frontend/src/main.tsx`

### Backend

Path: `apps/backend`

Technology:

- Bun runtime
- Hono web framework
- TypeScript
- PostgreSQL
- Redis Streams
- JWT auth
- WebSocket

Responsibilities:

- Auth routes.
- Camera CRUD routes.
- Alerts API.
- Start/stop command queue publishing.
- Alert queue consuming.
- Persisting alerts and stats.
- WebSocket fanout to the frontend.

Important file:

- `apps/backend/src/index.ts`

### Worker

Path: `services/worker`

Technology:

- Python
- FFmpeg
- OpenCV
- Ultralytics YOLOv8n
- Redis

Responsibilities:

- Listen to `camera.commands` queue.
- Start one thread per camera.
- Relay source RTSP stream into a MediaMTX camera-specific path.
- Read frames with OpenCV.
- Run YOLO person detection.
- Publish alerts into `camera.alerts` queue.
- Send camera state and stats to backend internal endpoints.

Important file:

- `services/worker/worker.py`

### MediaMTX

Path: `infra/mediamtx/mediamtx.yml`

Technology:

- MediaMTX media server

Responsibilities:

- Accept RTSP streams.
- Expose streams over WebRTC/WHEP.
- Expose HLS fallback streams.

### Database

Technology:

- PostgreSQL

Responsibilities:

- Store users.
- Store cameras.
- Store alerts.
- Store camera runtime state.
- Store camera stats.

Schema:

- `apps/backend/src/db/schema.sql`

### Redis

Technology:

- Redis Streams

Responsibilities:

- Message queue for camera commands.
- Message queue for person alerts.

Queues:

- `camera.commands`
- `camera.alerts`

## 4. High-level architecture

```text
React Dashboard
  | REST API + WebSocket
  v
Bun/Hono Backend ---- PostgreSQL
  |                     ^
  | camera.commands     | save alerts/state/stats
  v                     |
Redis Streams      camera.alerts
  |                     ^
  v                     |
Python Worker ---------+
  |
  | FFmpeg RTSP relay
  v
MediaMTX
  |
  | WebRTC/WHEP first, HLS fallback
  v
Browser video tile
```

## 5. End-to-end flow: starting a camera

1. User logs into the dashboard.
2. User adds a camera with an RTSP URL.
3. User clicks **Start**.
4. Frontend calls:
   - `POST /cameras/:id/start`
5. Backend verifies JWT and camera ownership.
6. Backend updates camera state to `starting`.
7. Backend pushes a message into Redis Stream `camera.commands`.
8. Python worker consumes the command.
9. Worker starts FFmpeg to relay the source RTSP stream into MediaMTX using a unique path like:
   - `camera-abc123...`
10. Worker marks camera as `live` through backend internal API.
11. Frontend receives `camera.state` WebSocket event.
12. Frontend tries to play:
   - WebRTC/WHEP: `http://localhost:8889/<streamPath>/whep`
13. If WebRTC fails locally, frontend falls back to:
   - HLS: `http://localhost:8888/<streamPath>/index.m3u8?cookieCheck=1`

## 6. End-to-end flow: person detection alert

1. Worker reads frames from the RTSP stream using OpenCV.
2. Worker runs YOLOv8n on a frame every configured detection interval.
3. Worker filters detections to COCO class `0`, which means `person`.
4. If a person is found and alert cooldown has passed, worker creates an alert payload.
5. Worker publishes payload into Redis Stream:
   - `camera.alerts`
6. Backend alert consumer reads `camera.alerts`.
7. Backend saves the alert in PostgreSQL.
8. Backend broadcasts `alert.created` through WebSocket.
9. Frontend updates the recent alert list in the camera tile.

## 7. Why Redis Streams are used

Redis Streams are the project message queue.

There are two queues:

### `camera.commands`

Direction:

```text
Backend -> Worker
```

Used for:

- `camera.start`
- `camera.stop`

Why:

- API request does not directly manage long-running camera work.
- Worker can restart and continue processing new commands.
- Multiple workers can be added later using consumer groups.

### `camera.alerts`

Direction:

```text
Worker -> Backend
```

Used for:

- `person_detected` alert events.

Why:

- Detector does not need to synchronously depend on alert persistence.
- Backend owns database writes and WebSocket broadcasting.
- Queue gives a clean event-driven architecture.

## 8. What Bun is

Bun is a JavaScript/TypeScript runtime, similar in purpose to Node.js.

In this project Bun runs the backend.

Why Bun is used:

- Fast startup.
- Built-in TypeScript support.
- Built-in WebSocket server support.
- Simple package/script runner.

Where it appears:

- Backend Dockerfile uses Bun image.
- Backend starts with `bun run src/index.ts`.
- Migrations run with `bun run src/db/migrate.ts`.

If asked “Why Bun instead of Node?”:

> Bun was chosen for fast TypeScript execution, a simple built-in server API, and easy WebSocket handling. The code could also be ported to Node.js/Express if needed, but Bun keeps the assignment implementation compact.

## 9. What Hono is

Hono is a lightweight web framework for JavaScript/TypeScript runtimes.

In this project Hono handles backend HTTP routes.

Examples:

- `POST /auth/signup`
- `POST /auth/login`
- `GET /cameras`
- `POST /cameras/:id/start`
- `GET /alerts`

If asked “Why Hono?”:

> Hono is lightweight, fast, TypeScript-friendly, and simple enough for a small backend API. It keeps routing and middleware clear without heavy framework overhead.

## 10. What WebRTC is

WebRTC is a browser technology for low-latency real-time media.

A browser cannot directly play RTSP. CCTV/IP cameras commonly output RTSP, but browsers do not support RTSP natively.

So the project uses this conversion path:

```text
RTSP camera -> Worker FFmpeg relay -> MediaMTX -> WebRTC/WHEP -> Browser
```

MediaMTX accepts RTSP and exposes a WebRTC endpoint.

The frontend creates an `RTCPeerConnection`, sends an SDP offer to the MediaMTX WHEP endpoint, receives an SDP answer, and attaches the received media track to a `<video>` element.

## 11. What WHEP is

WHEP means WebRTC-HTTP Egress Protocol.

It is a simple HTTP-based way for a browser to receive a WebRTC stream from a media server.

In this project:

```text
http://localhost:8889/<streamPath>/whep
```

The browser posts its SDP offer to that URL. MediaMTX replies with an SDP answer. Then the browser receives the media stream over WebRTC.

If asked “Is this real WebRTC?”:

> Yes. The frontend uses browser `RTCPeerConnection` and MediaMTX WHEP for WebRTC playback. HLS is only a fallback for local browser/network stability.

## 12. Why HLS fallback exists

WebRTC can fail locally because of browser autoplay rules, ICE/network issues, or local Docker networking quirks.

So the frontend tries WebRTC first. If it cannot start, it falls back to HLS.

HLS is not the primary assignment path. It is there to keep the demo watchable if WebRTC fails on a local machine.

## 13. Person detection model

The worker uses YOLOv8n from Ultralytics.

YOLOv8n means YOLO version 8 nano model.

Why this model:

- Lightweight.
- Runs on CPU.
- Detects COCO objects out of the box.
- COCO class `0` is `person`.
- Good enough for assignment/demo.

The worker only requests class `[0]`, so it only cares about people.

## 14. Alert metadata

A real detection alert has:

```json
"metadata": {
  "model": "yolov8n.pt",
  "source": "worker-xxxx",
  "simulatedFallback": false
}
```

For final submission, `simulatedFallback: false` proves it was produced by YOLO, not by fake/demo fallback logic.

Fake no-person alerts are disabled by default.

## 15. Docker Compose services

The main stack includes:

- `postgres`: database.
- `redis`: message queues.
- `mediamtx`: RTSP/WebRTC/HLS media server.
- `sample-camera`: generated RTSP test stream.
- `backend`: Bun/Hono API.
- `worker`: Python detection/relay worker.
- `frontend`: React dashboard served by Nginx.

Optional real-person demo profiles:

- `person-image-demo`
- `person-demo`

These are for proving real YOLO detection with a person image/video.

## 16. Important ports

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:3001`
- MediaMTX RTSP: `rtsp://localhost:8554`
- MediaMTX HLS: `http://localhost:8888`
- MediaMTX WebRTC/WHEP: `http://localhost:8889`
- Redis: `localhost:6379`
- PostgreSQL: internal Docker network only as `postgres:5432`

## 17. How to run

```bash
cp .env.example .env
docker compose up --build
```

Open:

```text
http://localhost:5173
```

Default signup/login can be any username/password with password length at least 6.

Example:

```text
username: demo
password: demo1234
```

## 18. How to add sample camera

In the dashboard add:

```text
Name: Sample Camera
RTSP URL: rtsp://mediamtx:8554/sample
Location: Demo Lab
```

Click **Start**.

Expected:

- Camera state becomes `live`.
- Browser video plays the generated test pattern.
- No real person alerts because the sample has no person.

## 19. How to prove real person detection

Quick path:

```bash
./scripts/fetch-person-demo.sh
docker compose --profile person-image-demo up -d person-image-camera
RTSP_URL=rtsp://mediamtx:8554/person-demo EXPECT_REAL_PERSON=true WAIT_SECONDS=60 ./scripts/validate-camera.sh
```

Expected result:

- `real_yolo_alerts` should be greater than `0`.
- `simulated_alerts` should be `0`.

## 20. How validation works

The validation script:

```bash
./scripts/validate-camera.sh
```

Checks:

- Backend health.
- Auth signup/login.
- Camera creation.
- Camera start.
- Camera state becomes `live`.
- MediaMTX HLS manifest is available.
- Alerts API works.

For real person detection:

```bash
RTSP_URL=rtsp://mediamtx:8554/person-demo EXPECT_REAL_PERSON=true WAIT_SECONDS=60 ./scripts/validate-camera.sh
```

This fails unless a real YOLO alert exists with `simulatedFallback: false`.

## 21. API summary

Auth:

- `POST /auth/signup`
- `POST /auth/login`
- `GET /auth/me`

Cameras:

- `GET /cameras`
- `POST /cameras`
- `GET /cameras/:id`
- `PATCH /cameras/:id`
- `DELETE /cameras/:id`
- `POST /cameras/:id/start`
- `POST /cameras/:id/stop`

Alerts:

- `GET /alerts`

Worker internal APIs:

- `POST /internal/state`
- `POST /internal/stats`
- `POST /internal/alerts`

Realtime:

- `GET /ws?token=<JWT>`

## 22. Database tables

Main tables:

- `users`: login accounts.
- `cameras`: configured cameras and RTSP URLs.
- `alerts`: person detection alerts.
- `camera_runtime_state`: current state such as `live`, `stopped`, `error`.
- `camera_stats`: FPS and detections/minute.

## 23. WebSocket events

The backend sends live events to the frontend.

Main event types:

- `connected`
- `camera.state`
- `camera.stats`
- `alert.created`

This allows the dashboard to update without polling.

## 24. What happens if a camera fails

The worker runs each camera in its own thread. If one camera fails, it reports state `error` or degraded state, but it does not stop the whole worker.

This is important for surveillance systems because one bad camera should not break all cameras.

## 25. Known limitations

Be honest if asked:

- No Kubernetes manifests are included; Docker Compose is used.
- No TURN server is included, so WebRTC across restrictive networks may need extra setup.
- Snapshot capture is not implemented yet.
- Formal unit/e2e tests are minimal; validation script is the main verification.
- CPU YOLO is fine for demo, but production should use GPU workers.

## 26. Strong answer if asked “Is it production ready?”

> It is assignment-ready and demonstrates the core production architecture: auth, camera CRUD, RTSP ingestion, WebRTC playback, Redis Stream queues, worker isolation, YOLO detection, persisted alerts, and WebSocket updates. For real production I would add TURN for WebRTC, GPU inference, alert snapshots, observability, Kubernetes, stronger tests, and hardened auth/session management.

## 27. Common interview questions and answers

### Why can’t the browser play RTSP directly?

Browsers do not support RTSP natively. The project uses MediaMTX to convert RTSP into WebRTC/WHEP for browser playback.

### Why use MediaMTX?

MediaMTX is a media server that can ingest RTSP and expose WebRTC/HLS endpoints. It avoids writing a custom media server.

### Why use FFmpeg in the worker?

FFmpeg restreams each source camera into a clean camera-specific MediaMTX path. This gives every dashboard camera its own playback URL.

### Why use Redis Streams?

Redis Streams provide durable-ish queue semantics and consumer groups. They decouple the API from long-running camera processing and decouple detector alerts from persistence/broadcast logic.

### Why not directly write alerts from worker to DB?

The backend should own database writes and user-facing event broadcasting. The worker only does media/detection work and publishes events. This separation is cleaner and easier to scale.

### How is user isolation handled?

Camera and alert queries are filtered by `user_id`. JWT contains the user identity. Protected APIs only return the logged-in user’s cameras and alerts.

### How does start/stop work?

Start/stop API calls publish messages to `camera.commands`. The worker consumes those messages and starts/stops camera threads.

### How does detection work?

The worker opens the RTSP source with OpenCV, periodically runs YOLOv8n on frames, filters for `person`, applies cooldown, and queues an alert.

### How do you know alerts are real?

Real YOLO alerts have `metadata.simulatedFallback: false`. The validation script checks this when `EXPECT_REAL_PERSON=true`.

### What is the fallback if WebRTC fails?

The frontend uses HLS fallback from MediaMTX, clearly labelled as fallback. WebRTC/WHEP remains the first playback attempt.

### How would you scale it?

Run multiple worker replicas using Redis Stream consumer groups, add GPU inference nodes, use object storage for snapshots, add monitoring, and split MediaMTX nodes for media scaling.

### What would you improve next?

Add TURN server support, Kubernetes manifests, Prometheus metrics, snapshots, formal e2e tests, refresh-token auth, and GPU model acceleration.

## 28. Final submission checklist

Before submitting:

```bash
docker compose up --build
./scripts/validate-camera.sh
./scripts/fetch-person-demo.sh
docker compose --profile person-image-demo up -d person-image-camera
RTSP_URL=rtsp://mediamtx:8554/person-demo EXPECT_REAL_PERSON=true WAIT_SECONDS=60 ./scripts/validate-camera.sh
```

Expected:

- Backend health OK.
- Camera state `live`.
- HLS manifest available.
- Real person alerts greater than 0.
- Simulated alerts equal 0.
- Redis queue groups have pending 0.

Queue checks:

```bash
docker compose exec redis redis-cli XINFO GROUPS camera.commands
docker compose exec redis redis-cli XINFO GROUPS camera.alerts
```

Expected:

- Consumer groups exist.
- `pending` is `0` after validation.

## 29. Short demo script

Use this if you need to explain while sharing screen:

1. “This is a real-time surveillance dashboard.”
2. “The frontend is React; the backend is Bun/Hono.”
3. “I add an RTSP camera and click Start.”
4. “Backend pushes a start command into Redis Streams.”
5. “Worker consumes it, starts FFmpeg relay, and runs YOLO.”
6. “MediaMTX exposes the stream as WebRTC/WHEP for the browser.”
7. “YOLO person alerts are queued back through `camera.alerts`.”
8. “Backend persists alerts and sends WebSocket events to the UI.”
9. “This alert metadata shows `simulatedFallback: false`, so it is a real model detection.”

## 30. Final status

The project is finalized for assignment submission with:

- Docker Compose stack.
- Bun/Hono backend.
- React frontend.
- WebRTC/WHEP playback.
- HLS fallback.
- Python worker.
- YOLOv8n person detection.
- Redis Streams message queues.
- PostgreSQL persistence.
- WebSocket real-time updates.
- Validation scripts and documentation.
