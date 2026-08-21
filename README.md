# TeslaCam Viewer

Lightweight, self-hosted Docker web application for browsing and playing TeslaUSB / TeslaCam archived clips.

Designed for **TrueNAS Scale + Portainer** and older hardware (Haswell-friendly).

## Features

- Clean dark-theme UI
- Browse **Saved**, **Sentry**, and **Recent** clips
- Filter by date range
- Multi-camera synchronized playback (front / back / left / right / pillars)
- Uses existing `thumb.png` when available, otherwise generates a thumbnail
- Optional HTTP Basic Authentication
- Read-only media mount
- Fully works offline after the page loads (videos stream from your NAS)

## Folder Structure Expected

The container expects one of these layouts under the mounted `/media`:

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
│   └── ...
└── RecentClips/                (optional)
    └── ...
```

Also works if the clips live under `/media/TeslaCam/...`.

## Quick Start (Portainer)

1. Copy the whole `teslacam-viewer` folder to your TrueNAS (or clone/build from this project).

2. Edit `docker-compose.yml` and change the volume path:

```yaml
volumes:
  - /mnt/Starlink/Tesla/TeslaUSB:/media:ro
```

3. In Portainer → **Stacks** → **Add stack** → paste the contents of `docker-compose.yml` (or upload the file).

4. Deploy the stack.

5. Open `http://<your-truenas-ip>:8000`

### Optional Authentication

Set environment variables:

```yaml
environment:
  - AUTH_USER=andre
  - AUTH_PASS=your-strong-password
```

Leave them empty to disable auth.

## Build Locally (optional)

```bash
cd teslacam-viewer
docker compose build
docker compose up -d
```

## Configuration Environment Variables

| Variable       | Default              | Description                          |
|----------------|----------------------|--------------------------------------|
| `MEDIA_PATH`   | `/media`             | Path inside container to clips       |
| `CLIPS_ROOT`   | (empty)              | Optional subfolder (e.g. `TeslaCam`) |
| `AUTH_USER`    | (empty)              | Basic auth username                  |
| `AUTH_PASS`    | (empty)              | Basic auth password                  |
| `TZ`           | `America/Toronto`    | Timezone                             |
| `PORT`         | `8000`               | Internal port                        |

## Keyboard Shortcuts

- `Space` – Play / Pause all cameras
- `←` / `→` – Seek ±5 seconds
- `M` – Mute / Unmute

## Notes for TrueNAS / Older Hardware

- The image is based on `python:3.12-slim` + ffmpeg (only used for optional thumbnails).
- All video streaming is handled by the browser; the backend just serves files.
- Recommended to keep the media volume **read-only** (`:ro`).
- You can limit CPU/memory in the compose file if desired.

## License

MIT – free to use and modify.
