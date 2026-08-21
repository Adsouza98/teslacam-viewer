# TeslaCam Viewer

Lightweight, self-hosted Docker web application for browsing and playing TeslaUSB / TeslaCam archived clips.

Designed for **TrueNAS Scale + Portainer** and older hardware (Haswell-friendly).

**Image:** `ghcr.io/adsouza98/teslacam-viewer:latest`

## Features

- Clean dark-theme UI
- Browse **Saved**, **Sentry**, and **Recent** clips
- Filter by date range
- Multi-camera synchronized playback (front / back / left / right / pillars)
- Uses existing `thumb.png` when available, otherwise generates a thumbnail
- Optional HTTP Basic Authentication
- Read-only media mount
- Runs as TrueNAS apps user (`PUID`/`PGID` 568 by default)

## Image (GHCR)

Every push to `main` publishes to GitHub Container Registry:

```
ghcr.io/adsouza98/teslacam-viewer:latest
```

Because this repository is **private**, Portainer needs a GitHub PAT (`read:packages`) registered as a Docker registry:

- Registry URL: `https://ghcr.io`
- Username: your GitHub username
- Password: PAT with `read:packages`

You do **not** clone this repo onto TrueNAS. Add the image to `homelab-stacks` and let Portainer pull it.

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

## License

MIT – free to use and modify.
