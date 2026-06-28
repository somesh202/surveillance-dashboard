# Deployment Options for Submission

The app is easiest to deploy on a free Linux VM because it needs multiple long-running services: frontend, backend, worker, PostgreSQL, Redis, MediaMTX, RTSP, WebRTC/WHEP, and HLS.

## Best free option: Oracle Cloud Always Free VM

Recommended for submission.

Why this is the best fit:

- Free VM with public IP.
- Runs Docker Compose directly.
- Supports multiple containers.
- Allows custom TCP/UDP ports needed by RTSP/WebRTC/HLS.
- You can submit a URL like `http://<PUBLIC_IP>:5173`.

### Required ports

Open these in Oracle Cloud security list / network security group and Ubuntu firewall:

- `5173/tcp` frontend
- `3001/tcp` backend API
- `8554/tcp` RTSP
- `8888/tcp` HLS fallback
- `8889/tcp` WebRTC/WHEP HTTP
- `8189/udp` WebRTC ICE

Do **not** expose PostgreSQL. It is internal-only in the Compose file.

Redis is currently published on `6379` for local debugging. For public deployment, either keep it firewalled or remove its host port mapping before production use.

### VM setup commands

On Ubuntu VM:

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
```

Log out and log back in, then clone/run:

```bash
git clone <YOUR_REPO_URL> surveillance-dashboard
cd surveillance-dashboard
cp .env.example .env
docker compose up -d --build
```

Open:

```text
http://<PUBLIC_IP>:5173
```

Backend health:

```text
http://<PUBLIC_IP>:3001/health
```

## Important environment changes for public VM

Edit `.env` on the VM:

```env
PUBLIC_API_URL=http://<PUBLIC_IP>:3001
MEDIAMTX_WEBRTC_URL=http://<PUBLIC_IP>:8889
MEDIAMTX_HLS_URL=http://<PUBLIC_IP>:8888
JWT_SECRET=<long-random-secret>
```

Then rebuild frontend/backend:

```bash
docker compose up -d --build frontend backend worker
```

The frontend needs these public URLs at build time because Vite embeds them into the static bundle.

## Validate after deployment

```bash
curl http://<PUBLIC_IP>:3001/health
./scripts/validate-camera.sh
```

For real person detection:

```bash
./scripts/fetch-person-demo.sh
docker compose --profile person-image-demo up -d person-image-camera
RTSP_URL=rtsp://mediamtx:8554/person-demo EXPECT_REAL_PERSON=true WAIT_SECONDS=60 ./scripts/validate-camera.sh
```

## Quick but weaker option: ngrok / Cloudflare Tunnel

Use this only if you cannot get a VM quickly.

Pros:

- Fast public URL.
- Good for showing frontend/backend over HTTP.

Cons:

- WebRTC UDP/ICE and RTSP are awkward through tunnels.
- You may rely on HLS fallback instead of full WebRTC.
- Multiple ports need multiple tunnels or a reverse proxy.

This is acceptable for a quick demo link, but less defensible than a real VM because the assignment is about WebRTC camera streaming.

## Services that are usually not ideal for this project

### Vercel / Netlify

Good for static frontend only, but not enough for MediaMTX, worker, Postgres, Redis, RTSP, and WebRTC ports.

### Render free tier

Good for simple web services, but not ideal for multi-container Docker Compose, RTSP, UDP ICE, and persistent media worker processes.

### Railway free/trial

Can run containers, but multi-service media + custom UDP/RTSP requirements are not as straightforward as a VM.

### Fly.io

Possible with Docker, but more complex for this full Compose stack and UDP/WebRTC configuration.

## Recommended submission wording

> I deployed the full Docker Compose stack on a Linux VM. The submitted URL points to the React dashboard. The backend, worker, PostgreSQL, Redis Streams queues, and MediaMTX all run as containers on the same VM. MediaMTX exposes RTSP ingest, WebRTC/WHEP playback, and HLS fallback. Redis Streams are used for camera commands and person-detection alert queues.

## Final recommendation

Use **Oracle Cloud Always Free VM** if you need a real public deployment URL for submission.
