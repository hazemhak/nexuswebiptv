# Nexus Web IPTV - Docker Hub Overview

[![Docker Pulls](https://img.shields.io/docker/pulls/hazemhak/nexuswebiptv.svg)](https://hub.docker.com/r/hazemhak/nexuswebiptv)
[![Docker Image Size](https://img.shields.io/docker/image-size/hazemhak/nexuswebiptv/latest)](https://hub.docker.com/r/hazemhak/nexuswebiptv)

**Nexus Web IPTV** is a self-hosted IPTV web player with a built-in **server-side stream proxy** and **M3U relay API**. It plays M3U/M3U8 playlists and Xtream Codes directly in the browser while routing all video traffic through your host server rather than your client device.

---

## 🌟 Key Features

- 🛡️ **Server-Side Stream Proxy**: Routes all live TV and VOD streams through your VPS host network. Keeps your client/home IP hidden from IPTV providers and bypasses ISP blocks.
- 🔄 **HLS Manifest Rewriter**: Automatically intercepts `.m3u8` playlists and rewrites `.ts` chunk segments on the fly.
- 📡 **External Player M3U Relay API**: Generates an M3U playlist URL that can be loaded into **TiviMate, IPTV Smarters, VLC, Kodi, or Smart TVs** with all streams proxied.
- 🔒 **Access Token Authentication**: Secure your instance with a custom login password (`IPTVNATOR_ACCESS_TOKEN`) and sign out with one click.
- 📺 **Full IPTV Client Support**: Live TV, Movies, Series, Catchup, and EPG (XMLTV).

---

## 🚀 Quick Start (Docker Compose)

Create a `docker-compose.yml` file:

```yaml
version: '3.8'

services:
  nexuswebiptv:
    image: hazemhak/nexuswebiptv:latest
    container_name: nexuswebiptv
    restart: unless-stopped
    ports:
      - "4333:80"
    environment:
      BACKEND_URL: /api
      CLIENT_URL: http://localhost:4333        # Set to http://YOUR_VPS_IP:4333 or domain
      PORT: "3000"
      IPTVNATOR_STORAGE: server
      IPTVNATOR_STREAM_PROXY: "1"              # 1 = Proxy all video through server
      IPTVNATOR_ACCESS_TOKEN: "YourPassword"   # Web login password (optional)
      IPTVNATOR_PROXY_ALLOW_PRIVATE_NETWORKS: "0"
    volumes:
      - nexus-data:/data

volumes:
  nexus-data:
```

Start the container:
```bash
docker compose up -d
```

Open your browser at:
👉 **`http://YOUR_SERVER_IP:4333`**

---

## 🏃 Quick Run (Docker CLI)

```bash
docker run -d \
  --name nexuswebiptv \
  -p 4333:80 \
  -e BACKEND_URL=/api \
  -e CLIENT_URL=http://localhost:4333 \
  -e IPTVNATOR_STORAGE=server \
  -e IPTVNATOR_STREAM_PROXY=1 \
  -e IPTVNATOR_ACCESS_TOKEN=YourPassword \
  -v nexus-data:/data \
  --restart unless-stopped \
  hazemhak/nexuswebiptv:latest
```

---

## ⚙️ Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `IPTVNATOR_STREAM_PROXY` | `1` | `1` = All video streams route through your server. `0` = Stream directly from browser. |
| `IPTVNATOR_ACCESS_TOKEN` | _(empty)_ | Password required to access the web app. |
| `IPTVNATOR_STORAGE` | `server` | Persists playlists, favorites, and history in the `/data` SQLite volume. |
| `CLIENT_URL` | `http://localhost:4333` | Allowed origin for web clients (e.g. `http://usa.almualla.one:4333`). |
| `PORT` | `3000` | Internal backend port (mapped behind internal Nginx). |
| `IPTVNATOR_PROXY_ALLOW_PRIVATE_NETWORKS` | `0` | Set `1` if your IPTV sources are on a private/LAN IP (e.g. `192.168.x.x`). |

---

## 📱 External IPTV Apps (TiviMate, Smarters, VLC)

To stream your playlists through your VPS on external players:

1. Open Nexus Web IPTV in your browser.
2. Go to **Settings** ➔ **Server / Source Sync**.
3. Under **External App M3U & Stream Proxy API**, select your playlist and copy the link:
   ```
   http://YOUR_SERVER_IP:4333/api/m3u?token=YourPassword
   ```
4. Paste into **TiviMate**, **VLC**, or any player. All stream traffic will be relayed through your VPS.

---

## 🔗 Links

- **GitHub Repository**: [https://github.com/hazemhak/nexuswebiptv](https://github.com/hazemhak/nexuswebiptv)
- **License**: MIT
