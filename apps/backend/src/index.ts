import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ServerWebSocket } from "bun";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";
import Redis from "ioredis";
import { z } from "zod";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://surveillance:surveillance@localhost:5432/surveillance";
const JWT_SECRET = process.env.JWT_SECRET ?? "local-surveillance-dashboard-jwt-2026";
const INTERNAL_WORKER_TOKEN = process.env.INTERNAL_WORKER_TOKEN ?? "local-surveillance-worker-token-2026";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const MEDIAMTX_WEBRTC_URL = process.env.MEDIAMTX_WEBRTC_URL ?? "http://localhost:8889";
const PORT = Number(process.env.PORT ?? 3000);

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const alertRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const ALERT_STREAM = "camera.alerts";
const ALERT_GROUP = "backend-alert-consumers";
const ALERT_CONSUMER = `backend-${crypto.randomUUID()}`;

const clients = new Map<string, Set<ServerWebSocket<AuthData>>>();
type AuthData = { userId: string; username: string };
type AppEnv = { Variables: AuthData };

const signupSchema = z.object({ username: z.string().min(3), password: z.string().min(6) });
const loginSchema = signupSchema;
const cameraSchema = z.object({
  name: z.string().min(1),
  rtspUrl: z.string().min(6),
  location: z.string().optional().default(""),
  enabled: z.boolean().optional().default(true),
});
const cameraPatchSchema = cameraSchema.partial();
const alertSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.literal("person_detected").default("person_detected"),
  cameraId: z.string().uuid(),
  userId: z.string().uuid(),
  timestamp: z.string().datetime(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  label: z.string().default("person"),
  bbox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable().optional(),
  frameWidth: z.number().int().nullable().optional(),
  frameHeight: z.number().int().nullable().optional(),
  trackId: z.string().nullable().optional(),
  snapshotUrl: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.any()).optional().default({}),
});

const stateSchema = z.object({ cameraId: z.string().uuid(), state: z.enum(["stopped", "starting", "connecting", "live", "error", "stopping"]), message: z.string().optional().default(""), workerId: z.string().optional() });
const statsSchema = z.object({ cameraId: z.string().uuid(), fps: z.number().default(0), detectionsPerMinute: z.number().int().default(0), bitrateKbps: z.number().int().default(0), lastFrameAt: z.string().datetime().nullable().optional() });

function signToken(user: AuthData) {
  return jwt.sign({ sub: user.userId, username: user.username }, JWT_SECRET, { expiresIn: "7d" });
}

function verifyToken(token: string): AuthData | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { sub: string; username: string };
    return { userId: decoded.sub, username: decoded.username };
  } catch {
    return null;
  }
}

function publicCamera(row: any) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    rtspUrl: row.rtsp_url,
    location: row.location,
    enabled: row.enabled,
    streamPath: row.stream_path,
    webrtcUrl: `${MEDIAMTX_WEBRTC_URL}/${row.stream_path}`,
    state: row.state ?? "stopped",
    stateMessage: row.message ?? "",
    fps: Number(row.fps ?? 0),
    detectionsPerMinute: Number(row.detections_per_minute ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicAlert(row: any) {
  return {
    id: row.id,
    type: row.type,
    cameraId: row.camera_id,
    userId: row.user_id,
    timestamp: row.timestamp,
    confidence: row.confidence == null ? null : Number(row.confidence),
    label: row.label,
    bbox: row.bbox,
    frameWidth: row.frame_width,
    frameHeight: row.frame_height,
    trackId: row.track_id,
    snapshotUrl: row.snapshot_url,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

function broadcast(userId: string, event: unknown) {
  const sockets = clients.get(userId);
  if (!sockets) return;
  const payload = JSON.stringify(event);
  for (const socket of sockets) socket.send(payload);
}

async function saveAlert(data: z.infer<typeof alertSchema>) {
  const result = await pool.query(`
    INSERT INTO alerts (id, user_id, camera_id, type, label, confidence, bbox, frame_width, frame_height, track_id, snapshot_url, metadata, timestamp)
    VALUES (COALESCE($1, uuid_generate_v4()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING *
  `, [data.id ?? null, data.userId, data.cameraId, data.type, data.label, data.confidence ?? null, data.bbox ? JSON.stringify(data.bbox) : null, data.frameWidth ?? null, data.frameHeight ?? null, data.trackId ?? null, data.snapshotUrl ?? null, JSON.stringify(data.metadata), data.timestamp]);
  const alert = publicAlert(result.rows[0]);
  broadcast(data.userId, { type: "alert.created", cameraId: data.cameraId, payload: alert });
  return alert;
}

async function auth(c: any, next: any) {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const user = verifyToken(token);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId", user.userId);
  c.set("username", user.username);
  await next();
}

function internalAuth(c: any, next: any) {
  if (c.req.header("x-worker-token") !== INTERNAL_WORKER_TOKEN) return c.json({ error: "Forbidden" }, 403);
  return next();
}

const app = new Hono<AppEnv>();
app.use("*", cors({ origin: "*", allowHeaders: ["Content-Type", "Authorization", "X-Worker-Token"], allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] }));

app.get("/health", (c) => c.json({ ok: true }));

app.post("/auth/signup", async (c) => {
  const parsed = signupSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const hash = await bcrypt.hash(parsed.data.password, 10);
  try {
    const result = await pool.query("INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username", [parsed.data.username, hash]);
    const user = { userId: result.rows[0].id, username: result.rows[0].username };
    return c.json({ token: signToken(user), user });
  } catch (error: any) {
    if (error.code === "23505") return c.json({ error: "Username already exists" }, 409);
    throw error;
  }
});

app.post("/auth/login", async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const result = await pool.query("SELECT id, username, password_hash FROM users WHERE username = $1", [parsed.data.username]);
  const userRow = result.rows[0];
  if (!userRow || !(await bcrypt.compare(parsed.data.password, userRow.password_hash))) return c.json({ error: "Invalid credentials" }, 401);
  const user = { userId: userRow.id, username: userRow.username };
  return c.json({ token: signToken(user), user });
});

app.get("/auth/me", auth, (c) => c.json({ user: { userId: c.get("userId"), username: c.get("username") } }));

app.get("/cameras", auth, async (c) => {
  const result = await pool.query(`
    SELECT c.*, rs.state, rs.message, st.fps, st.detections_per_minute
    FROM cameras c
    LEFT JOIN camera_runtime_state rs ON rs.camera_id = c.id
    LEFT JOIN camera_stats st ON st.camera_id = c.id
    WHERE c.user_id = $1 ORDER BY c.created_at DESC
  `, [c.get("userId")]);
  return c.json({ cameras: result.rows.map(publicCamera) });
});

app.post("/cameras", auth, async (c) => {
  const parsed = cameraSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const result = await pool.query(
    "INSERT INTO cameras (user_id, name, rtsp_url, location, enabled, stream_path) VALUES ($1, $2, $3, $4, $5, 'camera-' || replace(uuid_generate_v4()::text, '-', '')) RETURNING *",
    [c.get("userId"), parsed.data.name, parsed.data.rtspUrl, parsed.data.location, parsed.data.enabled]
  );
  await pool.query("INSERT INTO camera_runtime_state (camera_id, state) VALUES ($1, 'stopped')", [result.rows[0].id]);
  await pool.query("INSERT INTO camera_stats (camera_id) VALUES ($1)", [result.rows[0].id]);
  return c.json({ camera: publicCamera(result.rows[0]) }, 201);
});

app.get("/cameras/:id", auth, async (c) => {
  const result = await pool.query(`
    SELECT c.*, rs.state, rs.message, st.fps, st.detections_per_minute
    FROM cameras c
    LEFT JOIN camera_runtime_state rs ON rs.camera_id = c.id
    LEFT JOIN camera_stats st ON st.camera_id = c.id
    WHERE c.id = $1 AND c.user_id = $2
  `, [c.req.param("id"), c.get("userId")]);
  if (!result.rows[0]) return c.json({ error: "Camera not found" }, 404);
  return c.json({ camera: publicCamera(result.rows[0]) });
});

app.patch("/cameras/:id", auth, async (c) => {
  const parsed = cameraPatchSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const current = await pool.query("SELECT * FROM cameras WHERE id = $1 AND user_id = $2", [c.req.param("id"), c.get("userId")]);
  if (!current.rows[0]) return c.json({ error: "Camera not found" }, 404);
  const next = { ...current.rows[0], name: parsed.data.name ?? current.rows[0].name, rtsp_url: parsed.data.rtspUrl ?? current.rows[0].rtsp_url, location: parsed.data.location ?? current.rows[0].location, enabled: parsed.data.enabled ?? current.rows[0].enabled };
  const result = await pool.query("UPDATE cameras SET name=$1, rtsp_url=$2, location=$3, enabled=$4, updated_at=now() WHERE id=$5 AND user_id=$6 RETURNING *", [next.name, next.rtsp_url, next.location, next.enabled, c.req.param("id"), c.get("userId")]);
  return c.json({ camera: publicCamera(result.rows[0]) });
});

app.delete("/cameras/:id", auth, async (c) => {
  const camera = await pool.query("SELECT * FROM cameras WHERE id = $1 AND user_id = $2", [c.req.param("id"), c.get("userId")]);
  if (!camera.rows[0]) return c.json({ error: "Camera not found" }, 404);
  await redis.xadd("camera.commands", "*", "type", "camera.stop", "cameraId", camera.rows[0].id, "userId", c.get("userId"), "requestedAt", new Date().toISOString());
  await pool.query("DELETE FROM cameras WHERE id = $1 AND user_id = $2", [c.req.param("id"), c.get("userId")]);
  return c.json({ ok: true });
});

app.post("/cameras/:id/start", auth, async (c) => {
  const result = await pool.query("SELECT * FROM cameras WHERE id = $1 AND user_id = $2", [c.req.param("id"), c.get("userId")]);
  const camera = result.rows[0];
  if (!camera) return c.json({ error: "Camera not found" }, 404);
  if (!camera.enabled) return c.json({ error: "Camera disabled" }, 409);
  await pool.query("INSERT INTO camera_runtime_state (camera_id, state, message, updated_at) VALUES ($1, 'starting', 'Queued start command', now()) ON CONFLICT (camera_id) DO UPDATE SET state='starting', message='Queued start command', updated_at=now()", [camera.id]);
  await redis.xadd("camera.commands", "*", "type", "camera.start", "cameraId", camera.id, "userId", camera.user_id, "rtspUrl", camera.rtsp_url, "streamPath", camera.stream_path, "requestedAt", new Date().toISOString());
  broadcast(camera.user_id, { type: "camera.state", cameraId: camera.id, payload: { state: "starting", message: "Queued start command" } });
  return c.json({ ok: true });
});

app.post("/cameras/:id/stop", auth, async (c) => {
  const result = await pool.query("SELECT * FROM cameras WHERE id = $1 AND user_id = $2", [c.req.param("id"), c.get("userId")]);
  const camera = result.rows[0];
  if (!camera) return c.json({ error: "Camera not found" }, 404);
  await redis.xadd("camera.commands", "*", "type", "camera.stop", "cameraId", camera.id, "userId", camera.user_id, "requestedAt", new Date().toISOString());
  return c.json({ ok: true });
});

app.get("/alerts", auth, async (c) => {
  const cameraId = c.req.query("cameraId");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const page = Math.max(Number(c.req.query("page") ?? 1), 1);
  const pageSize = Math.min(Math.max(Number(c.req.query("pageSize") ?? 20), 1), 100);
  const values: any[] = [c.get("userId")];
  const clauses = ["user_id = $1"];
  if (cameraId) { values.push(cameraId); clauses.push(`camera_id = $${values.length}`); }
  if (from) { values.push(from); clauses.push(`timestamp >= $${values.length}`); }
  if (to) { values.push(to); clauses.push(`timestamp <= $${values.length}`); }
  values.push(pageSize, (page - 1) * pageSize);
  const result = await pool.query(`SELECT * FROM alerts WHERE ${clauses.join(" AND ")} ORDER BY timestamp DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  return c.json({ alerts: result.rows.map(publicAlert), page, pageSize });
});

app.post("/internal/alerts", internalAuth, async (c) => {
  const parsed = alertSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const alert = await saveAlert(parsed.data);
  return c.json({ alert }, 201);
});

app.post("/internal/state", internalAuth, async (c) => {
  const parsed = stateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const data = parsed.data;
  await pool.query(`INSERT INTO camera_runtime_state (camera_id, state, message, worker_id, started_at, stopped_at, updated_at)
    VALUES ($1, $2, $3, $4, CASE WHEN $2='live' THEN now() ELSE NULL END, CASE WHEN $2='stopped' THEN now() ELSE NULL END, now())
    ON CONFLICT (camera_id) DO UPDATE SET state=$2, message=$3, worker_id=$4, started_at=COALESCE(camera_runtime_state.started_at, EXCLUDED.started_at), stopped_at=EXCLUDED.stopped_at, updated_at=now()`,
    [data.cameraId, data.state, data.message, data.workerId ?? null]);
  const owner = await pool.query("SELECT user_id FROM cameras WHERE id=$1", [data.cameraId]);
  if (owner.rows[0]) broadcast(owner.rows[0].user_id, { type: "camera.state", cameraId: data.cameraId, payload: { state: data.state, message: data.message } });
  return c.json({ ok: true });
});

app.post("/internal/stats", internalAuth, async (c) => {
  const parsed = statsSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const data = parsed.data;
  await pool.query(`INSERT INTO camera_stats (camera_id, fps, detections_per_minute, bitrate_kbps, last_frame_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, now())
    ON CONFLICT (camera_id) DO UPDATE SET fps=$2, detections_per_minute=$3, bitrate_kbps=$4, last_frame_at=$5, updated_at=now()`,
    [data.cameraId, data.fps, data.detectionsPerMinute, data.bitrateKbps, data.lastFrameAt ?? null]);
  const owner = await pool.query("SELECT user_id FROM cameras WHERE id=$1", [data.cameraId]);
  if (owner.rows[0]) broadcast(owner.rows[0].user_id, { type: "camera.stats", cameraId: data.cameraId, payload: data });
  return c.json({ ok: true });
});

const server = Bun.serve<AuthData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const token = url.searchParams.get("token") ?? "";
      const user = verifyToken(token);
      if (!user) return new Response("Unauthorized", { status: 401 });
      if (server.upgrade(req, { data: user })) return;
      return new Response("Upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws) {
      const data = ws.data;
      if (!clients.has(data.userId)) clients.set(data.userId, new Set());
      clients.get(data.userId)!.add(ws as any);
      ws.send(JSON.stringify({ type: "connected", payload: { userId: data.userId } }));
    },
    close(ws) {
      clients.get(ws.data.userId)?.delete(ws as any);
    },
    message() {},
  },
});

console.log(`backend listening on http://localhost:${server.port}`);

async function startAlertQueueConsumer() {
  try {
    await alertRedis.xgroup("CREATE", ALERT_STREAM, ALERT_GROUP, "0", "MKSTREAM");
  } catch (error: any) {
    if (!String(error?.message ?? error).includes("BUSYGROUP")) throw error;
  }
  console.log(`alert queue consumer listening on ${ALERT_STREAM}`);
  while (true) {
    try {
      const streams = await alertRedis.xreadgroup("GROUP", ALERT_GROUP, ALERT_CONSUMER, "COUNT", 10, "BLOCK", 5000, "STREAMS", ALERT_STREAM, ">");
      if (!streams) continue;
      for (const [, entries] of streams as any[]) {
        for (const [messageId, pairs] of entries as any[]) {
          const fields: Record<string, string> = {};
          for (let i = 0; i < pairs.length; i += 2) fields[pairs[i]] = pairs[i + 1];
          try {
            const parsed = alertSchema.safeParse(JSON.parse(fields.payload ?? "{}"));
            if (!parsed.success) throw new Error(JSON.stringify(parsed.error.flatten()));
            await saveAlert(parsed.data);
            await alertRedis.xack(ALERT_STREAM, ALERT_GROUP, messageId);
          } catch (error) {
            console.error("alert queue message failed", messageId, error);
            await alertRedis.xack(ALERT_STREAM, ALERT_GROUP, messageId);
          }
        }
      }
    } catch (error) {
      console.error("alert queue consumer error", error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

startAlertQueueConsumer().catch((error) => console.error("alert queue consumer crashed", error));
