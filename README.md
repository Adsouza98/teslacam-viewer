# TeslaCam Viewer

Lightweight, self-hosted web app for browsing TeslaUSB / TeslaCam archives.

Play Saved, Sentry, and Recent clips with synchronized multi-camera playback. Runs in Docker, including on older NAS/homelab hardware.

**Image:** [`ghcr.io/adsouza98/teslacam-viewer:1.4.0`](https://github.com/Adsouza98/teslacam-viewer/pkgs/container/teslacam-viewer)

## Features

- Dark-theme UI that works on desktop, phones, and foldables
- Browse **Saved**, **Sentry**, and **Recent** clips (one card per event or day folder)
- Sequential 1-minute TeslaCam files play as a single timeline per camera
- Next-segment prefetch (double-buffer) so 1-minute clip boundaries don’t stutter
- Multi-camera sync watchdog: if one angle stalls, all pause with a Buffering… overlay and resync
- Driving HUD in Tesla-app style (Self-Driving badge, rotating wheel, accelerator/brake pedals) from telemetry in the MP4s — parsed locally. FSD software version is shown only if the clip actually embeds it
- Filter by date range
- Multi-camera synchronized playback (front / back / left / right / pillars)
- Per-camera fullscreen (button, player bar, or double-tap)
- Uses `thumb.png` when present, otherwise generates a thumbnail
- Optional HTTP Basic Authentication
- Read-only media mount

## Quick start

```bash
docker run -d --name teslacam-viewer \
  -p 8000:8000 \
  -e TZ=UTC \
  -v /path/to/TeslaUSB:/media:ro \
  ghcr.io/adsouza98/teslacam-viewer:1.4.0
```

Or with Compose:

```yaml
services:
  teslacam-viewer:
    image: ghcr.io/adsouza98/teslacam-viewer:1.4.0
    container_name: teslacam-viewer
    environment:
      PUID: "1000"
      PGID: "1000"
      TZ: UTC
      AUTH_USER: ""   # optional
      AUTH_PASS: ""   # optional
    volumes:
      - /path/to/TeslaUSB:/media:ro
      - teslacam-cache:/cache
    ports:
      - "8000:8000"
    restart: unless-stopped

volumes:
  teslacam-cache:
```

Then open `http://localhost:8000`.

The GHCR image is public — no GitHub login is required to pull it.

## Expected folder layout

Mount the TeslaUSB archive at `/media` (read-only). Either of these works:

```
/media/
├── SavedClips/
│   └── 2025-06-12_14-30-00/
│       ├── 2025-06-12_14-30-00-front.mp4
│       ├── 2025-06-12_14-30-00-back.mp4
│       ├── 2025-06-12_14-30-00-left_repeater.mp4
│       ├── 2025-06-12_14-30-00-right_repeater.mp4
│       ├── event.json          (optional)
│       └── thumb.png           (optional)
├── SentryClips/
│   └── 2025-06-12_15-01-22/
│       └── ...
└── RecentClips/
    └── 2025-06-12/                          # day folder (TeslaUSB)
        ├── 2025-06-12_14-01-00-front.mp4
        ├── 2025-06-12_14-01-00-back.mp4
        └── ...
```

```
/media/TeslaCam/SavedClips/...
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PUID` | `568` | UID the process runs as |
| `PGID` | `568` | GID the process runs as |
| `TZ` | `UTC` | Container timezone |
| `AUTH_USER` | (empty) | Optional basic-auth username |
| `AUTH_PASS` | (empty) | Optional basic-auth password |
| `MEDIA_PATH` | `/media` | Media path **inside** the container |
| `CACHE_PATH` | `/cache` | Thumbnail cache path inside the container |

Leave `AUTH_USER` / `AUTH_PASS` empty to disable login. On TrueNAS SCALE the apps user is typically `568:568`.

## Keyboard / touch

- `Space` – Play / Pause all cameras
- `←` / `→` – Seek ±5 seconds
- `Esc` – Exit camera fullscreen
- **Front** (maximize icon) – expand the front camera only
- Per-camera button or **double-tap** a video – fullscreen that angle

## Build from source

```bash
docker build -t teslacam-viewer .
docker run --rm -p 8000:8000 -v /path/to/TeslaUSB:/media:ro teslacam-viewer
```

Pushing to `main` publishes `VERSION` and `latest` to GHCR.

## License

MIT
