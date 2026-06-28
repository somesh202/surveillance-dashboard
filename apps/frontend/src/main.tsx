import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, Camera, LogOut, Plus, Trash2 } from 'lucide-react';
import Hls from 'hls.js';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const HLS_BASE = import.meta.env.VITE_MEDIAMTX_HLS_URL ?? 'http://localhost:8888';

function waitForIceGathering(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      if (peer.iceGatheringState === 'complete') {
        peer.removeEventListener('icegatheringstatechange', done);
        resolve();
      }
    };
    peer.addEventListener('icegatheringstatechange', done);
    setTimeout(() => {
      peer.removeEventListener('icegatheringstatechange', done);
      resolve();
    }, 3000);
  });
}

type User = { userId: string; username: string };
type CameraRow = {
  id: string;
  name: string;
  rtspUrl: string;
  location: string;
  enabled: boolean;
  streamPath: string;
  webrtcUrl: string;
  state: string;
  stateMessage: string;
  fps: number;
  detectionsPerMinute: number;
};
type AlertRow = { id: string; cameraId: string; timestamp: string; confidence: number | null; label: string; bbox?: unknown; metadata?: Record<string, unknown> };

type AuthState = { token: string; user: User } | null;

function tokenFromStorage(): AuthState {
  const token = localStorage.getItem('token');
  const user = localStorage.getItem('user');
  return token && user ? { token, user: JSON.parse(user) } : null;
}

async function api<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function AuthPage({ onAuth }: { onAuth: (auth: AuthState) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await api<{ token: string; user: User }>(`/auth/${mode}`, { method: 'POST', body: JSON.stringify({ username, password }) });
      localStorage.setItem('token', result.token);
      localStorage.setItem('user', JSON.stringify(result.user));
      onAuth(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  }

  return <main className="auth-shell">
    <section className="auth-card">
      <div className="brand"><Camera size={34} /><span>Skylark VMS</span></div>
      <h1>{mode === 'login' ? 'Welcome back' : 'Create account'}</h1>
      <p>Real-time RTSP surveillance, WebRTC playback, and person detection alerts.</p>
      <form onSubmit={submit}>
        <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} minLength={3} /></label>
        <label>Password<input value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} type="password" /></label>
        {error && <div className="error-box">{error}</div>}
        <button disabled={loading}>{loading ? 'Please wait...' : mode === 'login' ? 'Login' : 'Sign up'}</button>
      </form>
      <button className="link-button" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>{mode === 'login' ? 'Need an account?' : 'Already registered?'}</button>
    </section>
  </main>;
}

function CameraForm({ token, onCreated }: { token: string; onCreated: () => void }) {
  const [name, setName] = useState('Lobby Camera');
  const [rtspUrl, setRtspUrl] = useState('rtsp://mediamtx:8554/sample');
  const [location, setLocation] = useState('Main Lobby');
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api('/cameras', { method: 'POST', body: JSON.stringify({ name, rtspUrl, location, enabled: true }) }, token);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create camera');
    }
  }

  return <form className="camera-form" onSubmit={submit}>
    <input placeholder="Camera name" value={name} onChange={(e) => setName(e.target.value)} />
    <input placeholder="RTSP URL" value={rtspUrl} onChange={(e) => setRtspUrl(e.target.value)} />
    <input placeholder="Location" value={location} onChange={(e) => setLocation(e.target.value)} />
    <button><Plus size={16} /> Add camera</button>
    {error && <span className="inline-error">{error}</span>}
  </form>;
}

function CameraVideo({ camera }: { camera: CameraRow }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState('Connecting with WebRTC...');
  const [transport, setTransport] = useState<'WebRTC' | 'HLS fallback'>('WebRTC');

  const requestPlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    video.play().then(() => setStatus('')).catch(() => setStatus('Waiting for stream data...'));
  };

  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    if (!video) return;
    let peer: RTCPeerConnection | null = null;
    let hls: Hls | null = null;
    let fallbackTimer: number | undefined;

    const hlsUrl = `${HLS_BASE.replace(/\/$/, '')}/${camera.streamPath}/index.m3u8?cookieCheck=1`;

    const onPlaying = () => setStatus('');
    const onWaiting = () => setStatus('Buffering live stream...');
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);

    const startHlsFallback = () => {
      if (cancelled || hls) return;
      peer?.close();
      peer = null;
      setTransport('HLS fallback');
      setStatus('WebRTC unavailable, using HLS fallback...');

      if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl;
      video.play().catch(() => setStatus('Click the video to start playback'));
      } else if (Hls.isSupported()) {
        hls = new Hls({ liveSyncDurationCount: 2 });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => setStatus('Click the video to start playback'));
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setStatus('Waiting for stream manifest...');
            window.setTimeout(() => hls?.startLoad(), 2000);
            return;
          }
          if (data.fatal) setStatus(`Stream error: ${data.details}`);
        });
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
      } else {
        setStatus('This browser cannot play the live stream');
      }
    };

    const startWebRtc = async () => {
      try {
        peer = new RTCPeerConnection({ iceServers: [] });
        peer.addTransceiver('video', { direction: 'recvonly' });
        peer.addTransceiver('audio', { direction: 'recvonly' });
        peer.ontrack = (event) => {
          if (!cancelled && event.streams[0]) {
            window.clearTimeout(fallbackTimer);
            video.srcObject = event.streams[0];
            video.play().catch(() => setStatus('Click the video to start playback'));
            setTransport('WebRTC');
            setStatus('');
          }
        };
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForIceGathering(peer);

        const response = await fetch(`${camera.webrtcUrl.replace(/\/$/, '')}/whep`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: peer.localDescription?.sdp ?? offer.sdp ?? '',
        });
        if (!response.ok) throw new Error(await response.text());
        await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
      } catch {
        startHlsFallback();
      }
    };

    fallbackTimer = window.setTimeout(startHlsFallback, 8000);
    startWebRtc();

    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimer);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      peer?.close();
      hls?.destroy();
      video.srcObject = null;
      video.removeAttribute('src');
      video.load();
    };
  }, [camera.id, camera.streamPath, camera.webrtcUrl]);

  return <>
    <video ref={videoRef} autoPlay muted playsInline controls onClick={requestPlayback} />
    <span className="transport-badge">{transport}</span>
    {status && <button type="button" className="video-status" onClick={requestPlayback}>{status}</button>}
  </>;
}

function CameraTile({ camera, alerts, token, onRefresh }: { camera: CameraRow; alerts: AlertRow[]; token: string; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(camera.name);
  const [editRtspUrl, setEditRtspUrl] = useState(camera.rtspUrl);
  const [editLocation, setEditLocation] = useState(camera.location);
  const [editEnabled, setEditEnabled] = useState(camera.enabled);

  useEffect(() => {
    setEditName(camera.name);
    setEditRtspUrl(camera.rtspUrl);
    setEditLocation(camera.location);
    setEditEnabled(camera.enabled);
  }, [camera.id, camera.name, camera.rtspUrl, camera.location, camera.enabled]);

  async function action(kind: 'start' | 'stop') {
    setBusy(true);
    try {
      await api(`/cameras/${camera.id}/${kind}`, { method: 'POST' }, token);
      setTimeout(onRefresh, 500);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!confirm(`Delete ${camera.name}?`)) return;
    await api(`/cameras/${camera.id}`, { method: 'DELETE' }, token);
    onRefresh();
  }
  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(`/cameras/${camera.id}`, { method: 'PATCH', body: JSON.stringify({ name: editName, rtspUrl: editRtspUrl, location: editLocation, enabled: editEnabled }) }, token);
      setEditing(false);
      onRefresh();
    } finally {
      setBusy(false);
    }
  }
  const running = ['starting', 'connecting', 'live'].includes(camera.state);
  const canShowVideo = camera.state === 'live';
  return <article className="tile">
    <div className="video-wrap">
      {canShowVideo ? <CameraVideo camera={camera} /> : <div className="placeholder"><Camera size={42} /><span>{running ? 'Preparing stream...' : 'Stream stopped'}</span></div>}
      <span className={`badge ${camera.state}`}>{camera.state}</span>
    </div>
    <div className="tile-body">
      <div className="tile-title"><div><h3>{camera.name}</h3><p>{camera.location || 'No location'}</p></div><button className="icon-btn" onClick={remove}><Trash2 size={16} /></button></div>
      {editing ? <form className="edit-form" onSubmit={saveEdit}>
        <input placeholder="Camera name" value={editName} onChange={(e) => setEditName(e.target.value)} />
        <input placeholder="RTSP URL" value={editRtspUrl} onChange={(e) => setEditRtspUrl(e.target.value)} />
        <input placeholder="Location" value={editLocation} onChange={(e) => setEditLocation(e.target.value)} />
        <label className="inline-check"><input type="checkbox" checked={editEnabled} onChange={(e) => setEditEnabled(e.target.checked)} /> Enabled</label>
        <div className="actions"><button disabled={busy}>Save</button><button type="button" className="secondary" onClick={() => setEditing(false)}>Cancel</button></div>
      </form> : <button className="secondary edit-toggle" onClick={() => setEditing(true)}>Edit camera</button>}
      {camera.stateMessage && <p className="state-message">{camera.stateMessage}</p>}
      <div className="stats"><span>FPS <b>{camera.fps.toFixed(1)}</b></span><span>Detections/min <b>{camera.detectionsPerMinute}</b></span></div>
      <div className="actions">
        <button disabled={busy || running} onClick={() => action('start')}>Start</button>
        <button disabled={busy || camera.state === 'stopped'} className="secondary" onClick={() => action('stop')}>Stop</button>
      </div>
      <h4>Recent alerts</h4>
      <ul className="alerts">
        {alerts.slice(0, 4).map((alert) => <li key={alert.id}><Activity size={14} /> Person {(alert.confidence ? alert.confidence * 100 : 0).toFixed(0)}% <time>{new Date(alert.timestamp).toLocaleTimeString()}</time></li>)}
        {alerts.length === 0 && <li className="muted">No alerts yet</li>}
      </ul>
    </div>
  </article>;
}

function Dashboard({ auth, onLogout }: { auth: NonNullable<AuthState>; onLogout: () => void }) {
  const [cameras, setCameras] = useState<CameraRow[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [error, setError] = useState('');

  const groupedAlerts = useMemo(() => alerts.reduce<Record<string, AlertRow[]>>((acc, alert) => {
    acc[alert.cameraId] = acc[alert.cameraId] || [];
    acc[alert.cameraId].push(alert);
    return acc;
  }, {}), [alerts]);

  async function load() {
    try {
      const [cameraData, alertData] = await Promise.all([
        api<{ cameras: CameraRow[] }>('/cameras', {}, auth.token),
        api<{ alerts: AlertRow[] }>('/alerts?pageSize=50', {}, auth.token),
      ]);
      setCameras(cameraData.cameras);
      setAlerts(alertData.alerts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load dashboard');
    }
  }

  useEffect(() => { load(); }, []);
  useEffect(() => {
    const wsBase = API_BASE.replace(/^http/, 'ws');
    const socket = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(auth.token)}`);
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data);
      if (event.type === 'alert.created') setAlerts((current) => [event.payload, ...current].slice(0, 100));
      if (event.type === 'camera.state') setCameras((current) => current.map((camera) => camera.id === event.cameraId ? { ...camera, state: event.payload.state, stateMessage: event.payload.message } : camera));
      if (event.type === 'camera.stats') setCameras((current) => current.map((camera) => camera.id === event.cameraId ? { ...camera, fps: event.payload.fps, detectionsPerMinute: event.payload.detectionsPerMinute } : camera));
    };
    return () => socket.close();
  }, [auth.token]);

  return <main className="dashboard">
    <header className="topbar"><div><h1>Surveillance Dashboard</h1><p>{cameras.length} cameras · {alerts.length} recent alerts</p></div><div className="user-pill">{auth.user.username}<button onClick={onLogout}><LogOut size={16} /> Logout</button></div></header>
    {error && <div className="error-box">{error}</div>}
    <CameraForm token={auth.token} onCreated={load} />
    <section className="grid">
      {cameras.map((camera) => <CameraTile key={camera.id} camera={camera} alerts={groupedAlerts[camera.id] ?? []} token={auth.token} onRefresh={load} />)}
      {cameras.length === 0 && <div className="empty"><Camera size={48} /><h2>No cameras yet</h2><p>Add the default sample camera and press Start.</p></div>}
    </section>
  </main>;
}

function App() {
  const [auth, setAuth] = useState<AuthState>(tokenFromStorage());
  function logout() { localStorage.clear(); setAuth(null); }
  return auth ? <Dashboard auth={auth} onLogout={logout} /> : <AuthPage onAuth={setAuth} />;
}

createRoot(document.getElementById('root')!).render(<App />);
