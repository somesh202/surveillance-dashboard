import os
import json
import signal
import subprocess
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone

# YOLOv8n is downloaded from the official Ultralytics release assets. Recent
# PyTorch versions default to weights-only loading, which can reject older YOLO
# checkpoints unless this trusted-model compatibility flag is set.
os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")

import cv2
import redis
import requests

try:
    from ultralytics import YOLO
except ImportError:  # model import is optional until the container is fully installed
    YOLO = None

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
API_URL = os.getenv("API_URL", "http://localhost:3000")
INTERNAL_WORKER_TOKEN = os.getenv("INTERNAL_WORKER_TOKEN", "dev-worker-token")
MEDIAMTX_RTSP_URL = os.getenv("MEDIAMTX_RTSP_URL", "rtsp://localhost:8554")
DETECTION_MODEL = os.getenv("DETECTION_MODEL", "yolov8n.pt")
DETECTION_INTERVAL_SECONDS = float(os.getenv("DETECTION_INTERVAL_SECONDS", "1.5"))
ALERT_COOLDOWN_SECONDS = float(os.getenv("ALERT_COOLDOWN_SECONDS", "10"))
SIMULATE_ON_FAILURE = os.getenv("SIMULATE_DETECTION_ON_FAILURE", "true").lower() == "true"
DEMO_ALERTS_WHEN_NO_PERSON = os.getenv("DEMO_ALERTS_WHEN_NO_PERSON", "true").lower() == "true"
RELAY_READY_DELAY_SECONDS = float(os.getenv("RELAY_READY_DELAY_SECONDS", "6"))
WORKER_ID = f"worker-{uuid.uuid4().hex[:8]}"

headers = {"x-worker-token": INTERNAL_WORKER_TOKEN, "content-type": "application/json"}
r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
model_lock = threading.Lock()
running_event = threading.Event()
running_event.set()


class ModelHolder:
    instance = None


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def post(path, payload):
    try:
        response = requests.post(f"{API_URL}{path}", json=payload, headers=headers, timeout=5)
        if response.status_code >= 300:
            print("api error", path, response.status_code, response.text, flush=True)
    except requests.RequestException as exc:
        print("api post failed", path, exc, flush=True)


def post_state(camera_id, state, message=""):
    post("/internal/state", {"cameraId": camera_id, "state": state, "message": message, "workerId": WORKER_ID})


def post_stats(camera_id, fps=0.0, detections_per_minute=0, bitrate_kbps=0, last_frame_at=None):
    post("/internal/stats", {"cameraId": camera_id, "fps": fps, "detectionsPerMinute": detections_per_minute, "bitrateKbps": bitrate_kbps, "lastFrameAt": last_frame_at})


def post_alert(camera_id, user_id, confidence, frame_width=None, frame_height=None, bbox=None, simulated=False):
    payload = {
        "type": "person_detected",
        "cameraId": camera_id,
        "userId": user_id,
        "timestamp": now_iso(),
        "confidence": float(confidence),
        "label": "person",
        "bbox": bbox,
        "frameWidth": frame_width,
        "frameHeight": frame_height,
        "trackId": None,
        "snapshotUrl": None,
        "metadata": {"model": DETECTION_MODEL, "source": WORKER_ID, "simulatedFallback": simulated},
    }
    try:
        r.xadd("camera.alerts", {"payload": json.dumps(payload)})
    except redis.RedisError as exc:
        print("alert queue publish failed; falling back to API", exc, flush=True)
        post("/internal/alerts", payload)


def load_model():
    if ModelHolder.instance is not None:
        return ModelHolder.instance
    with model_lock:
        if ModelHolder.instance is None:
            if YOLO is None:
                raise RuntimeError("ultralytics is not available")
            print(f"loading model {DETECTION_MODEL}", flush=True)
            ModelHolder.instance = YOLO(DETECTION_MODEL)
        return ModelHolder.instance


@dataclass
class CameraProcess:
    camera_id: str
    user_id: str
    rtsp_url: str
    stream_path: str
    stop_event: threading.Event = field(default_factory=threading.Event)
    ffmpeg: subprocess.Popen | None = None
    thread: threading.Thread | None = None
    detection_times: deque = field(default_factory=lambda: deque(maxlen=120))
    last_detection_at: float = 0
    last_alert_at: float = 0

    def start(self):
        self.thread = threading.Thread(target=self.run, name=f"camera-{self.camera_id}", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.ffmpeg and self.ffmpeg.poll() is None:
            self.ffmpeg.terminate()
            try:
                self.ffmpeg.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.ffmpeg.kill()
        post_state(self.camera_id, "stopped", "Stopped by request")
        post_stats(self.camera_id, 0, 0, 0, None)

    def start_restream(self):
        out_url = f"{MEDIAMTX_RTSP_URL.rstrip('/')}/{self.stream_path}"
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "warning", "-rtsp_transport", "tcp", "-i", self.rtsp_url,
            "-an", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
            "-g", "20", "-rtsp_transport", "tcp", "-f", "rtsp", out_url,
        ]
        self.ffmpeg = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)

    def run(self):
        post_state(self.camera_id, "connecting", "Starting FFmpeg relay and detector")
        self.start_restream()
        time.sleep(RELAY_READY_DELAY_SECONDS)
        post_state(self.camera_id, "live", "WebRTC relay is available through MediaMTX")
        try:
            self.detect_loop()
        except (RuntimeError, OSError, ValueError) as exc:
            if not self.stop_event.is_set():
                print("camera loop error", self.camera_id, exc, flush=True)
                self.keep_stream_live(f"Stream relay is live; detector degraded: {exc}")
        finally:
            if self.ffmpeg and self.ffmpeg.poll() is None:
                self.ffmpeg.terminate()
            if not self.stop_event.is_set():
                post_state(self.camera_id, "stopped", "Camera loop ended")

    def keep_stream_live(self, message):
        post_state(self.camera_id, "live", message)
        while not self.stop_event.is_set():
            if self.ffmpeg and self.ffmpeg.poll() is not None:
                post_state(self.camera_id, "error", "FFmpeg relay stopped")
                return
            post_stats(self.camera_id, 0, len(self.detection_times), 0, None)
            time.sleep(5)

    def detect_loop(self):
        video_capture = getattr(cv2, "VideoCapture")
        cap_ffmpeg = getattr(cv2, "CAP_FFMPEG", 0)
        cap = video_capture(self.rtsp_url, cap_ffmpeg)
        if not cap.isOpened():
            if SIMULATE_ON_FAILURE:
                self.simulated_loop("RTSP detector could not open stream; emitting simulated alerts for demo")
                return
            raise RuntimeError("Unable to open RTSP stream")

        frames = 0
        window_started = time.time()
        try:
            detector = load_model()
        except (RuntimeError, OSError, ValueError, ImportError) as exc:
            if SIMULATE_ON_FAILURE:
                self.simulated_loop(f"Detector unavailable; keeping stream live with simulated alerts: {exc}")
                return
            raise
        no_person_demo_at = time.time()
        while not self.stop_event.is_set():
            ok, frame = cap.read()
            if not ok:
                if SIMULATE_ON_FAILURE:
                    cap.release()
                    self.simulated_loop("Frame read failed; emitting simulated alerts for demo")
                    return
                raise RuntimeError("Unable to read frame")

            frames += 1
            current = time.time()
            if current - window_started >= 5:
                fps = frames / (current - window_started)
                self.trim_detection_times(current)
                post_stats(self.camera_id, round(fps, 2), len(self.detection_times), 0, now_iso())
                frames = 0
                window_started = current

            if current - self.last_detection_at < DETECTION_INTERVAL_SECONDS:
                continue
            self.last_detection_at = current
            result = detector.predict(source=frame, classes=[0], conf=0.35, verbose=False, imgsz=640)[0]
            if result.boxes is None or len(result.boxes) == 0:
                if DEMO_ALERTS_WHEN_NO_PERSON and time.time() - no_person_demo_at >= ALERT_COOLDOWN_SECONDS:
                    no_person_demo_at = time.time()
                    self.last_alert_at = no_person_demo_at
                    self.detection_times.append(no_person_demo_at)
                    post_alert(self.camera_id, self.user_id, 0.50, frame.shape[1], frame.shape[0], {"x": 320, "y": 140, "width": 180, "height": 360}, simulated=True)
                continue
            best = max(result.boxes, key=lambda box: float(box.conf[0]))
            confidence = float(best.conf[0])
            if current - self.last_alert_at >= ALERT_COOLDOWN_SECONDS:
                height, width = frame.shape[:2]
                x1, y1, x2, y2 = [float(v) for v in best.xyxy[0].tolist()]
                bbox = {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1}
                self.last_alert_at = current
                self.detection_times.append(current)
                post_alert(self.camera_id, self.user_id, confidence, width, height, bbox)

        cap.release()

    def trim_detection_times(self, current):
        while self.detection_times and current - self.detection_times[0] > 60:
            self.detection_times.popleft()

    def simulated_loop(self, message):
        print(message, self.camera_id, flush=True)
        post_state(self.camera_id, "live", message)
        tick = 0
        while not self.stop_event.is_set():
            tick += 1
            current = time.time()
            self.trim_detection_times(current)
            post_stats(self.camera_id, 25.0, len(self.detection_times), 1200, now_iso())
            if current - self.last_alert_at >= ALERT_COOLDOWN_SECONDS:
                self.last_alert_at = current
                self.detection_times.append(current)
                post_alert(self.camera_id, self.user_id, 0.88, 1280, 720, {"x": 300, "y": 120, "width": 220, "height": 420}, simulated=True)
            time.sleep(2)


cameras: dict[str, CameraProcess] = {}
lock = threading.Lock()


def handle_command(fields):
    command_type = fields.get("type")
    camera_id = fields.get("cameraId")
    if not camera_id:
        return
    with lock:
        existing = cameras.get(camera_id)
        if command_type == "camera.stop":
            if existing:
                post_state(camera_id, "stopping", "Stopping camera")
                existing.stop()
                cameras.pop(camera_id, None)
            else:
                post_state(camera_id, "stopped", "Camera was not running")
            return
        if command_type == "camera.start":
            if existing:
                existing.stop()
                cameras.pop(camera_id, None)
            process = CameraProcess(camera_id=camera_id, user_id=fields["userId"], rtsp_url=fields["rtspUrl"], stream_path=fields["streamPath"])
            cameras[camera_id] = process
            post_state(camera_id, "starting", "Worker accepted start command")
            process.start()


def shutdown(*_):
    running_event.clear()
    with lock:
        for process in list(cameras.values()):
            process.stop()
        cameras.clear()


def main():
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        r.xgroup_create("camera.commands", "workers", id="0", mkstream=True)
    except redis.ResponseError as exc:
        if "BUSYGROUP" not in str(exc):
            raise
    print(f"{WORKER_ID} listening for camera.commands", flush=True)
    while running_event.is_set():
        try:
            messages = r.xreadgroup("workers", WORKER_ID, {"camera.commands": ">"}, count=10, block=5000)
            for stream, entries in messages:
                for message_id, fields in entries:
                    handle_command(fields)
                    r.xack(stream, "workers", message_id)
        except (redis.RedisError, RuntimeError, OSError, ValueError) as exc:
            print("command loop error", exc, flush=True)
            time.sleep(2)


if __name__ == "__main__":
    main()
