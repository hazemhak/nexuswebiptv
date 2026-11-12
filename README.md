# Nexus Web IPTV 📺

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](docker/docker-compose.yml)

**Nexus Web IPTV** is a self-hosted, full-featured web-based IPTV player and media gateway. It provides a modern browser player for M3U playlists and Xtream Codes with a **server-side stream proxy** that keeps your home/client IP private, bypasses ISP blocks, and allows external players to stream through your VPS.

---

## Features

- 🌐 **Web PWA Player**: Run anywhere in your browser (desktop, tablet, mobile).
- 🛡️ **Server-Side Stream Proxy**:
  - All video playback traffic routes through your host VPS rather than the user's browser.
  - Automatically parses and rewrites HLS (`.m3u8`) manifests so TS segments are fetched through the proxy.
  - Transparently pipes MPEG-TS, MP4, and raw byte streams with range requests (seeking support).
  - Built-in SSRF and private-network protection.
- 📡 **M3U Export & Relayed API for External Players**:
  - Connect external IPTV apps (**TiviMate, IPTV Smarters, VLC, Kodi, Smart TVs**) directly to your Nexus Web IPTV server.
  - Generate whole-library or single-playlist M3U URLs directly from the Settings UI.
  - All video streams accessed by external apps are proxied through your server.
- 🔒 **Password Protection & One-Click Sign Out**:
  - Protect your instance with a global access token (`IPTVNATOR_ACCESS_TOKEN`).
  - Sign-in screen (`/server-sign-in`) and logout button directly in the navigation rail.
- 📺 **Rich IPTV Features**:
  - Full support for **M3U** and **M3U8** playlists.
  - **Xtream Codes** API support (Live TV, VOD, Series).
  - **EPG (Electronic Program Guide)** support with XMLTV / XML.GZ parsing.
  - TV Archive / Catchup playback.
  - Multi-language interface, dark/light themes, and favorites management.

---

## 🚀 Quick Start with Docker (Recommended)

### 1. Prerequisites
- Docker & Docker Compose installed on your host / VPS.

### 2. Option A: Run directly from Docker Hub (Fastest)
```bash
docker run -d \
  --name nexuswebiptv \
  -p 4333:80 \
  -e IPTVNATOR_STREAM_PROXY=1 \
  -e IPTVNATOR_ACCESS_TOKEN=HHak1680 \
  -e CLIENT_URL=http://usa.almualla.one:4333 \
  -v nexuswebiptv-data:/data \
  --restart unless-stopped \
  hazemhak/nexuswebiptv:latest
```

### 3. Option B: Run with Docker Compose
Clone the repository and start the container:

```bash
git clone https://github.com/hazemhak/nexuswebiptv.git
cd nexuswebiptv/docker
docker compose up -d
```

Access the app in your browser at:
👉 **`http://YOUR_SERVER_IP:4333`**

---

## ⚙️ Configuration (`docker/docker-compose.yml`)

```yaml
services:
  nexuswebiptv:
    image: hazemhak/nexuswebiptv:latest
    restart: unless-stopped
    ports:
      - "4333:80"
    environment:
      BACKEND_URL: /api
      CLIENT_URL: http://localhost:4333        # Set to http://YOUR_VPS_IP:4333 in production
      PORT: "3000"
      IPTVNATOR_STORAGE: server
      IPTVNATOR_STREAM_PROXY: "1"              # 1 = All video streams route through VPS
      IPTVNATOR_ACCESS_TOKEN: HHak1680         # Web login password (leave empty to disable)
      IPTVNATOR_PROXY_ALLOW_PRIVATE_NETWORKS: "0" # Set to "1" if your IPTV server is on a LAN IP
    volumes:
      - iptvnator-data:/data
```

### Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `IPTVNATOR_STREAM_PROXY` | `1` | `1` to route all video traffic through your server; `0` to stream direct from browser. |
| `IPTVNATOR_ACCESS_TOKEN` | `admin123` | Password required to access the web app. |
| `IPTVNATOR_STORAGE` | `server` | Saves playlists and viewing state to persistent server database (`/data`). |
| `CLIENT_URL` | `http://localhost:4333` | Allowed origin for web clients (set to your domain or VPS IP). |
| `IPTVNATOR_PROXY_ALLOW_PRIVATE_NETWORKS`| `0` | Set `1` if your IPTV sources are on local private IPs (e.g. `192.168.x.x`). |

---

## 📱 Connecting External Players (TiviMate, Smarters, VLC)

You can use Nexus Web IPTV as your personal IPTV proxy server for external devices:

1. Open Nexus Web IPTV in your browser: `http://YOUR_SERVER_IP:4333`.
2. Go to **Settings** ➔ **Server / Source Sync**.
3. Scroll to **External App M3U & Stream Proxy API**:
   - Choose **All Playlists (Merged)** or an individual playlist.
   - Click **Copy API Link**.
4. Paste the copied URL into **TiviMate**, **IPTV Smarters**, or **VLC**:
   ```
   http://YOUR_SERVER_IP:4333/api/m3u?token=admin123
   ```
*Every channel played through that URL will stream through your VPS, protecting your client network.*

---

## 🛠️ Local Development

### Requirements
- Node.js 22+ or 24+
- `pnpm` (`npm install -g pnpm@10.33.0`)

### Setup
```bash
git clone https://github.com/hazemhak/nexuswebiptv.git
cd nexuswebiptv

pnpm install --frozen-lockfile
```

### Start Development Servers
```bash
# Terminal 1: Backend API & Stream Proxy
pnpm run serve:backend

# Terminal 2: Angular Frontend PWA
pnpm run serve:frontend
```

---

## 🤖 Maintenance & AI Agent Guide

For detailed instructions on building multi-arch Docker images, memory limits, and publishing to Docker Hub, see:
- 📖 [Docker Build & Docker Hub Publishing Guide](docs/maintenance/docker-hub-agent-guide.md)
- 📖 [Docker Hub Summary](DOCKERHUB.md)

---

## 📜 Acknowledgements & License

Based on the open-source [4gray/iptvnator](https://github.com/4gray/iptvnator) project. Distributed under the [MIT License](LICENSE.md).
