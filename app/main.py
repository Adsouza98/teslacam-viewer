"""TeslaCam Viewer - FastAPI backend for TeslaUSB / TeslaCam archives."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from pydantic_settings import BaseSettings
from starlette.middleware.cors import CORSMiddleware
import secrets

from app.sei import extract_cached


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
DAY_FOLDER_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CLIP_FILE_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-("
    + "|".join(re.escape(s) for s in CAMERA_SUFFIXES)
    + r")\.mp4$",
    re.IGNORECASE,
)


def get_media_root() -> Path:
    root = Path(settings.media_path)
    if settings.clips_root:
        root = root / settings.clips_root
    return root


def parse_event_folder(name: str) -> Optional[datetime]:
    try:
        return datetime.strptime(name, "%Y-%m-%d_%H-%M-%S")
    except ValueError:
        pass
    try:
        return datetime.strptime(name, "%Y-%m-%d")
    except ValueError:
        return None


def collect_segments(dir_path: Path) -> Dict[str, List[str]]:
    """Collect ordered 1-minute clips per camera in a folder."""
    segs: Dict[str, List[str]] = defaultdict(list)
    try:
        files = sorted(dir_path.iterdir(), key=lambda p: p.name)
    except OSError:
        return {}
    for f in files:
        if not f.is_file() or f.suffix.lower() != ".mp4":
            continue
        m = CLIP_FILE_RE.match(f.name)
        if m:
            segs[m.group(2).lower()].append(f.name)
            continue
        name = f.stem.lower()
        for cam in CAMERA_SUFFIXES:
            if name.endswith(f"-{cam}") or name == cam:
                segs[cam].append(f.name)
                break
    return {cam: names for cam, names in segs.items() if names}


def clip_range(segments: Dict[str, List[str]]) -> Tuple[Optional[datetime], Optional[datetime]]:
    stamps: List[datetime] = []
    for names in segments.values():
        for name in names:
            m = CLIP_FILE_RE.match(name)
            if not m:
                continue
            dt = parse_event_folder(m.group(1))
            if dt:
                stamps.append(dt)
    if not stamps:
        return None, None
    return min(stamps), max(stamps)


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


def find_thumb(event_dir: Path) -> Optional[str]:
    for t in ("thumb.png", "thumbnail.png", "preview.jpg"):
        if (event_dir / t).is_file():
            return t
    return None


def _append_folder_event(
    events: List[Dict[str, Any]],
    seen: Set[Tuple[str, str]],
    root: Path,
    event_dir: Path,
    event_type: str,
    folder: str,
) -> None:
    segments = collect_segments(event_dir)
    if not segments:
        return
    key = (event_type, folder)
    if key in seen:
        return

    start, end = clip_range(segments)
    dt = start or parse_event_folder(folder)
    if not dt:
        return

    seen.add(key)
    cameras = {cam: files[0] for cam, files in segments.items()}
    clip_count = max(len(files) for files in segments.values())
    event_meta = load_event_json(event_dir)
    events.append(
        {
            "id": f"{event_type}/{folder}",
            "type": event_type.replace("Clips", ""),
            "folder": folder,
            "datetime": dt.isoformat(),
            "datetime_end": end.isoformat() if end else None,
            "timestamp": int(dt.timestamp()),
            "cameras": cameras,
            "segments": segments,
            "clip_count": clip_count,
            "has_event_json": event_meta is not None,
            "event": event_meta,
            "thumb": find_thumb(event_dir),
            "path": str(event_dir.relative_to(root)),
        }
    )


def scan_loose_by_day(
    clips_dir: Path,
    event_type: str,
    root: Path,
    seen: Set[Tuple[str, str]],
    events: List[Dict[str, Any]],
) -> None:
    """Group mp4s sitting directly in a clips dir into one event per calendar day."""
    by_day: Dict[str, Dict[str, List[str]]] = defaultdict(lambda: defaultdict(list))
    try:
        files = sorted(clips_dir.iterdir(), key=lambda p: p.name)
    except OSError:
        return
    for f in files:
        if not f.is_file() or f.suffix.lower() != ".mp4":
            continue
        m = CLIP_FILE_RE.match(f.name)
        if not m:
            continue
        day = m.group(1)[:10]
        by_day[day][m.group(2).lower()].append(f.name)

    for day, segs in by_day.items():
        key = (event_type, day)
        if key in seen:
            continue
        start, end = clip_range(segs)
        dt = start or parse_event_folder(day)
        if not dt:
            continue
        seen.add(key)
        cameras = {cam: files[0] for cam, files in segs.items()}
        events.append(
            {
                "id": f"{event_type}/{day}",
                "type": event_type.replace("Clips", ""),
                "folder": day,
                "datetime": dt.isoformat(),
                "datetime_end": end.isoformat() if end else None,
                "timestamp": int(dt.timestamp()),
                "cameras": cameras,
                "segments": dict(segs),
                "clip_count": max(len(files) for files in segs.values()),
                "has_event_json": False,
                "event": None,
                "thumb": find_thumb(clips_dir),
                "path": str(clips_dir.relative_to(root)),
            }
        )


def scan_events() -> List[Dict[str, Any]]:
    """Scan media root: one event per Saved/Sentry folder or Recent day folder."""
    root = get_media_root()
    events: List[Dict[str, Any]] = []

    if not root.exists():
        return events

    candidates = [
        root / "SavedClips",
        root / "SentryClips",
        root / "RecentClips",
        root / "TeslaCam" / "SavedClips",
        root / "TeslaCam" / "SentryClips",
        root / "TeslaCam" / "RecentClips",
    ]

    seen: Set[Tuple[str, str]] = set()

    for clips_dir in candidates:
        if not clips_dir.is_dir():
            continue

        event_type = clips_dir.name

        try:
            entries = list(clips_dir.iterdir())
        except OSError:
            continue

        for entry in entries:
            if not entry.is_dir():
                continue
            if EVENT_FOLDER_RE.match(entry.name) or DAY_FOLDER_RE.match(entry.name):
                _append_folder_event(events, seen, root, entry, event_type, entry.name)

        scan_loose_by_day(clips_dir, event_type, root, seen, events)

    events.sort(key=lambda e: e["timestamp"], reverse=True)
    return events


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="TeslaCam Viewer",
    description="Lightweight viewer for TeslaUSB / TeslaCam archived clips",
    version="1.3.0",
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


@app.get("/api/telemetry/{event_id:path}")
async def get_telemetry(event_id: str, _: bool = Depends(check_auth)):
    """Return driving HUD samples extracted locally from dashcam SEI."""
    events = scan_events()
    event = next((e for e in events if e["id"] == event_id), None)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    root = get_media_root()
    event_dir = root / event["path"]
    segs = event.get("segments") or {}
    cam_files = segs.get("front") or event.get("cameras", {}).get("front")
    if isinstance(cam_files, str):
        cam_files = [cam_files]
    if not cam_files:
        # any camera
        if segs:
            cam_files = next(iter(segs.values()))
        elif event.get("cameras"):
            cam_files = [next(iter(event["cameras"].values()))]
        else:
            cam_files = []

    cache_root = Path(settings.cache_path)

    def _run():
        out_segs = []
        for name in cam_files:
            video = event_dir / name
            samples = extract_cached(video, cache_root)
            out_segs.append({"file": name, "samples": samples, "count": len(samples)})
        available = any(s["count"] for s in out_segs)
        return {"available": available, "segments": out_segs}

    return await asyncio.to_thread(_run)


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
