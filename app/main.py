"""TeslaCam Viewer - FastAPI backend for TeslaUSB / TeslaCam archives."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from pydantic_settings import BaseSettings
from starlette.middleware.cors import CORSMiddleware
import secrets


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

class Settings(BaseSettings):
    media_path: str = "/media"
    clips_root: Optional[str] = None  # e.g. "TeslaCam" if nested
    auth_user: Optional[str] = None
    auth_pass: Optional[str] = None
    cache_path: str = "/cache"
    timezone: str = "UTC"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

security = HTTPBasic(auto_error=False)


def check_auth(credentials: Optional[HTTPBasicCredentials] = Depends(security)):
    if not settings.auth_user or not settings.auth_pass:
        return True  # auth disabled

    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Basic"},
        )

    correct_user = secrets.compare_digest(credentials.username, settings.auth_user)
    correct_pass = secrets.compare_digest(credentials.password, settings.auth_pass)

    if not (correct_user and correct_pass):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": "Basic"},
        )
    return True


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

CAMERA_SUFFIXES = [
    "front",
    "back",
    "left_repeater",
    "right_repeater",
    "left_pillar",
    "right_pillar",
]

EVENT_FOLDER_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$")


def get_media_root() -> Path:
    root = Path(settings.media_path)
    if settings.clips_root:
        root = root / settings.clips_root
    return root


def parse_event_folder(name: str) -> Optional[datetime]:
    try:
        return datetime.strptime(name, "%Y-%m-%d_%H-%M-%S")
    except ValueError:
        return None


def find_cameras(event_dir: Path) -> Dict[str, str]:
    """Return {camera_name: relative_path} for available .mp4 files."""
    cameras = {}
    for f in event_dir.iterdir():
        if not f.is_file() or f.suffix.lower() != ".mp4":
            continue
        name = f.stem.lower()
        for cam in CAMERA_SUFFIXES:
            if name.endswith(f"-{cam}") or name == cam:
                cameras[cam] = f.name
                break
        else:
            # fallback: try to extract from common patterns
            for cam in CAMERA_SUFFIXES:
                if cam in name:
                    cameras[cam] = f.name
                    break
    return cameras


def load_event_json(event_dir: Path) -> Optional[Dict[str, Any]]:
    for candidate in ("event.json", "Event.json"):
        p = event_dir / candidate
        if p.is_file():
            try:
                with open(p, "r", encoding="utf-8") as fh:
                    return json.load(fh)
            except Exception:
                return None
    return None


def scan_events() -> List[Dict[str, Any]]:
    """Scan media root and return sorted list of events (newest first)."""
    root = get_media_root()
    events: List[Dict[str, Any]] = []

    if not root.exists():
        return events

    # Support both /media/{Saved,Sentry,Recent}Clips and /media/TeslaCam/{...}
    candidates = [
        root / "SavedClips",
        root / "SentryClips",
        root / "RecentClips",
        root / "TeslaCam" / "SavedClips",
        root / "TeslaCam" / "SentryClips",
        root / "TeslaCam" / "RecentClips",
    ]

    seen = set()

    for clips_dir in candidates:
        if not clips_dir.is_dir():
            continue

        event_type = clips_dir.name  # SavedClips / SentryClips / RecentClips

        for entry in clips_dir.iterdir():
            if not entry.is_dir():
                continue
            if not EVENT_FOLDER_RE.match(entry.name):
                continue

            key = (event_type, entry.name)
            if key in seen:
                continue
            seen.add(key)

            dt = parse_event_folder(entry.name)
            if not dt:
                continue

            cameras = find_cameras(entry)
            if not cameras:
                continue

            event_meta = load_event_json(entry)
            thumb = None
            for t in ("thumb.png", "thumbnail.png", "preview.jpg"):
                if (entry / t).is_file():
                    thumb = t
                    break

            events.append(
                {
                    "id": f"{event_type}/{entry.name}",
                    "type": event_type.replace("Clips", ""),
                    "folder": entry.name,
                    "datetime": dt.isoformat(),
                    "timestamp": int(dt.timestamp()),
                    "cameras": cameras,
                    "has_event_json": event_meta is not None,
                    "event": event_meta,
                    "thumb": thumb,
                    "path": str(entry.relative_to(root)),
                }
            )

    # Newest first
    events.sort(key=lambda e: e["timestamp"], reverse=True)
    return events


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="TeslaCam Viewer",
    description="Lightweight viewer for TeslaUSB / TeslaCam archived clips",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static frontend
static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/", response_class=HTMLResponse)
async def index(_: bool = Depends(check_auth)):
    index_path = static_dir / "index.html"
    return HTMLResponse(content=index_path.read_text(encoding="utf-8"))


@app.get("/api/events")
async def list_events(
    type: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    limit: int = 200,
    offset: int = 0,
    _: bool = Depends(check_auth),
):
    """Return list of events with optional filtering."""
    events = scan_events()

    if type:
        type_map = {
            "saved": "Saved",
            "sentry": "Sentry",
            "recent": "Recent",
        }
        wanted = type_map.get(type.lower(), type)
        events = [e for e in events if e["type"].lower() == wanted.lower()]

    if from_date:
        try:
            from_ts = datetime.fromisoformat(from_date).timestamp()
            events = [e for e in events if e["timestamp"] >= from_ts]
        except ValueError:
            pass

    if to_date:
        try:
            to_ts = datetime.fromisoformat(to_date).timestamp()
            events = [e for e in events if e["timestamp"] <= to_ts]
        except ValueError:
            pass

    total = len(events)
    page = events[offset : offset + limit]

    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "events": page,
    }


@app.get("/api/event/{event_id:path}")
async def get_event(event_id: str, _: bool = Depends(check_auth)):
    """Return details for a single event."""
    events = scan_events()
    for e in events:
        if e["id"] == event_id:
            return e
    raise HTTPException(status_code=404, detail="Event not found")


@app.get("/media/{file_path:path}")
async def serve_media(file_path: str, request: Request, _: bool = Depends(check_auth)):
    """Serve video / thumbnail files with Range support."""
    root = get_media_root()
    full = (root / file_path).resolve()

    # Security: prevent path traversal
    if not str(full).startswith(str(root.resolve())):
        raise HTTPException(status_code=403, detail="Forbidden")

    if not full.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    # Let Starlette handle Range requests for seeking
    return FileResponse(
        path=full,
        media_type="video/mp4" if full.suffix.lower() == ".mp4" else "application/octet-stream",
        filename=full.name,
    )


@app.get("/api/health")
async def health():
    root = get_media_root()
    return {
        "status": "ok",
        "media_exists": root.exists(),
        "media_path": str(root),
    }


# Optional: simple thumbnail generation endpoint (uses ffmpeg if available)
@app.get("/api/thumb/{event_id:path}")
async def get_or_generate_thumb(event_id: str, _: bool = Depends(check_auth)):
    """Return existing thumb or generate a quick one from the front camera."""
    events = scan_events()
    event = next((e for e in events if e["id"] == event_id), None)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    root = get_media_root()
    event_dir = root / event["path"]

    # Prefer existing
    if event.get("thumb"):
        thumb_path = event_dir / event["thumb"]
        if thumb_path.is_file():
            return FileResponse(thumb_path, media_type="image/png")

    # Try to generate from front camera (cached)
    cache_dir = Path(settings.cache_path)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_key = hashlib.md5(event_id.encode()).hexdigest()
    cache_file = cache_dir / f"{cache_key}.jpg"

    if cache_file.is_file():
        return FileResponse(cache_file, media_type="image/jpeg")

    front = event["cameras"].get("front")
    if not front:
        # fallback to any camera
        front = next(iter(event["cameras"].values()), None)

    if not front:
        raise HTTPException(status_code=404, detail="No camera available for thumbnail")

    video_path = event_dir / front

    # Generate with ffmpeg (non-blocking-ish)
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-y",
            "-ss", "00:00:01",
            "-i", str(video_path),
            "-vframes", "1",
            "-q:v", "5",
            "-vf", "scale=320:-1",
            str(cache_file),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=15)
        if cache_file.is_file():
            return FileResponse(cache_file, media_type="image/jpeg")
    except Exception:
        pass

    raise HTTPException(status_code=404, detail="Could not generate thumbnail")
