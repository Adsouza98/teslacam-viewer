# TeslaCam Viewer

Lightweight, self-hosted Docker web application for browsing and playing TeslaUSB / TeslaCam archived clips.

Designed for **TrueNAS Scale + Portainer** and older hardware (Haswell-friendly).

**Image:** `ghcr.io/adsouza98/teslacam-viewer:1.1.0`

Version is defined in `VERSION`. Pushing to `main` publishes that tag (and `latest`) to GHCR. Bump `VERSION` for a new release so Portainer/Renovate can pick it up.

## Features

- Clean dark-theme UI, tuned for phones and foldables (Galaxy Z Fold folded + unfolded)
- Browse **Saved**, **Sentry**, and **Recent** clips
- Filter by date range
- Multi-camera synchronized playback (front / back / left / right / pillars)
- Fullscreen a single camera (button or double-tap)
- Uses existing `thumb.png` when available, otherwise generates a thumbnail
- Optional HTTP Basic Authentication
- Read-only media mount
- Runs as TrueNAS apps user (`PUID`/`PGID` 568 by default)

## Image (GHCR)

```
ghcr.io/adsouza98/teslacam-viewer:1.1.0
```

Because this repository is **private**, Portainer needs a GitHub PAT (`read:packages`) registered as a Docker registry:

- Registry URL: `https://ghcr.io`
- Username: your GitHub username
- Password: PAT with `read:packages`

You do **not** clone this repo onto TrueNAS. Pin the version in `homelab-stacks` and let Portainer poll git / Renovate bump the tag.

## Folder Structure Expected

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
└── RecentClips/
```

Also works if the clips live under `/media/TeslaCam/...`.

## Portainer environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PUID` | `568` | Process user ID (TrueNAS apps) |
| `PGID` | `568` | Process group ID |
| `TZ` | `America/Toronto` | Timezone |
| `TESLACAM_MEDIA_PATH` | `/mnt/Starlink/Tesla/TeslaUSB` | Host path to TeslaUSB dataset |
| `TESLACAM_AUTH_USER` | (empty) | Optional basic auth username |
| `TESLACAM_AUTH_PASS` | (empty) | Optional basic auth password |
| `TESLACAM_PORT` | `8000` | Host port |

Leave auth empty to disable login.

## Keyboard / touch

- `Space` – Play / Pause all cameras
- `←` / `→` – Seek ±5 seconds
- `M` – Mute / Unmute
- `Esc` – Exit camera fullscreen
- Camera **expand** button or **double-tap** a video – fullscreen that angle

## License

MIT – free to use and modify.
