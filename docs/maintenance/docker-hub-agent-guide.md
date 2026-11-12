# AI Agent Guide: Docker Build & Docker Hub Release Procedure

> **Target Audience**: AI Coding Agents & Automated CI/CD Pipelines.
> **Repository**: [hazemhak/nexuswebiptv](https://github.com/hazemhak/nexuswebiptv)
> **Docker Hub Image**: `hazemhak/nexuswebiptv:latest`

This document outlines the exact architecture, prerequisites, memory constraints, and commands required to build, tag, and publish Docker images for **Nexus Web IPTV**.

---

## 1. System Architecture & Context

Nexus Web IPTV is a containerized multi-tier application composed of:
1. **Frontend PWA**: Angular SPA located in `apps/web` (uses Nx monorepo).
2. **Backend Service**: Node.js/Express service in `apps/web-backend`.
3. **Internal Reverse Proxy**: Alpine Nginx listening on port `80`, routing `/api` to Node.js (`PORT 3000`), `/api/stream-proxy` with unbuffered streaming headers, and serving the static PWA assets from `/usr/share/nginx/html`.
4. **Shared Libraries**: `@iptvnator/services`, `@iptvnator/ui/playback`, `@iptvnator/shared/database` (Drizzle ORM + SQLite).

---

## 2. Critical Build Caveats (Must Read)

### A. Node.js Memory Allocation (`--max-old-space-size=4096`)
- **Problem**: Compiling the full Angular PWA and vendor chunks (Video.js, Shaka Player, ArtPlayer, HLS.js) requires significant memory. Standard Node default heap (~1.4GB) causes:
  ```text
  Error [ERR_WORKER_OUT_OF_MEMORY]: Worker terminated due to reaching memory limit: JS heap out of memory
  ```
- **Solution**: The Dockerfile includes:
  ```dockerfile
  ENV NODE_OPTIONS="--max-old-space-size=4096"
  ```
- **Host Requirement**: The build host must have at least **4GB of total virtual memory** (Physical RAM + Swap). If running on a 1GB/2GB VPS, ensure a swapfile is active (`swapon --show`).

### B. Windows Local Build Environment
- On Windows development environments where Docker CLI executes via Podman/Docker Desktop:
  - Binaries are located at `C:\Users\ADMIN\AppData\Local\Programs\DockerDesktop\resources\bin`.
  - Stored credential helper is `docker-credential-wincred.exe`.
  - Always prepend the bin path:
    ```powershell
    $env:PATH = "C:\Users\ADMIN\AppData\Local\Programs\DockerDesktop\resources\bin;" + $env:PATH
    ```

---

## 3. Automated Cloud CI/CD (GitHub Actions)

The repository has an automated workflow configured at `.github/workflows/docker.yml`.

### Secrets Configured in GitHub:
- `DOCKERHUB_USERNAME`: `hazemhak`
- `DOCKERHUB_TOKEN`: Personal Access Token with write permissions to `hazemhak/nexuswebiptv`.

### Triggering via Git Push:
Any push or PR merge to branch `main` automatically triggers a multi-architecture (`linux/amd64`, `linux/arm64`) build and pushes to `hazemhak/nexuswebiptv:latest`.

### Triggering Manually via GitHub CLI:
```bash
gh workflow run docker.yml --ref main -f push=true
```

---

## 4. Manual Local / CLI Build Procedure

When building locally on a machine with Docker or Podman:

### Step 1: Navigate to Project Root
The build context **must be the repository root** because the Dockerfile references `apps/`, `libs/`, `patches/`, `tools/`, and root package manifests.

```bash
cd /path/to/nexuswebiptv
```

### Step 2: Build the Container Image
```bash
# Standard Docker build:
docker build -f docker/Dockerfile -t hazemhak/nexuswebiptv:latest --load .

# Or using Podman:
podman build -f docker/Dockerfile -t hazemhak/nexuswebiptv:latest .
```

### Step 3: Authenticate to Docker Hub
```bash
# Interactive:
docker login

# Or headless (using token / stdin):
echo "$DOCKERHUB_TOKEN" | docker login -u hazemhak --password-stdin
```

### Step 4: Push to Docker Hub
```bash
docker push hazemhak/nexuswebiptv:latest
```

---

## 5. Verification Checklist for Agents

After completing a build/push:
1. Verify the image exists on Docker Hub:
   ```bash
   curl -s "https://hub.docker.com/v2/repositories/hazemhak/nexuswebiptv/tags/latest" | grep -q "name" && echo "Verified"
   ```
2. Verify container startup locally:
   ```bash
   docker run --rm -d --name test-nexus -p 4333:80 hazemhak/nexuswebiptv:latest
   curl -I http://localhost:4333/api/health
   docker stop test-nexus
   ```
3. Check healthcheck response:
   - Expected status: `HTTP/1.1 200 OK`
   - JSON body: `{"status":"ok","service":"nexus-web-iptv-backend"}`
