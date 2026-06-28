CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cameras (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  rtsp_url text NOT NULL,
  location text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  stream_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cameras_user_id_idx ON cameras(user_id);

CREATE TABLE IF NOT EXISTS alerts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  type text NOT NULL,
  label text NOT NULL,
  confidence numeric,
  bbox jsonb,
  frame_width integer,
  frame_height integer,
  track_id text,
  snapshot_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  timestamp timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alerts_user_timestamp_idx ON alerts(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS alerts_camera_timestamp_idx ON alerts(camera_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS camera_runtime_state (
  camera_id uuid PRIMARY KEY REFERENCES cameras(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'stopped',
  message text NOT NULL DEFAULT '',
  worker_id text,
  started_at timestamptz,
  stopped_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS camera_stats (
  camera_id uuid PRIMARY KEY REFERENCES cameras(id) ON DELETE CASCADE,
  fps numeric NOT NULL DEFAULT 0,
  detections_per_minute integer NOT NULL DEFAULT 0,
  bitrate_kbps integer NOT NULL DEFAULT 0,
  last_frame_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
