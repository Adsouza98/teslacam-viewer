"""Extract Tesla dashcam SEI telemetry from MP4 files.

Tesla embeds driving telemetry (speed, steering, pedals, Autopilot/FSD)
as H.264/H.265 SEI user-data protobuf in dashcam clips from firmware
2025.44.25+ (HW3+). Parked Sentry clips often have none.

All processing is local — video never leaves the host.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

GEAR = {0: "P", 1: "D", 2: "R", 3: "N"}
AP = {0: "NONE", 1: "FSD", 2: "AUTOSTEER", 3: "TACC"}


def _decode_varint(buf: bytes, i: int) -> Tuple[int, int]:
    shift = 0
    val = 0
    while i < len(buf):
        b = buf[i]
        i += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, i
        shift += 7
        if shift > 63:
            break
    return val, i


def parse_sei_metadata(data: bytes) -> Optional[Dict[str, Any]]:
    """Decode Tesla SeiMetadata proto3 without generated stubs."""
    if not data:
        return None
    out: Dict[str, Any] = {}
    i = 0
    n = len(data)
    try:
        while i < n:
            key, i = _decode_varint(data, i)
            field, wtype = key >> 3, key & 7
            if field == 0:
                break
            if wtype == 0:
                val, i = _decode_varint(data, i)
                if field == 1:
                    out["version"] = val
                elif field == 2:
                    out["gear"] = GEAR.get(val, "?")
                elif field == 3:
                    out["frame"] = val
                elif field == 7:
                    out["blink_l"] = bool(val)
                elif field == 8:
                    out["blink_r"] = bool(val)
                elif field == 9:
                    out["brake"] = bool(val)
                elif field == 10:
                    out["ap"] = AP.get(val, "NONE")
            elif wtype == 5:
                if i + 4 > n:
                    break
                (val,) = struct.unpack("<f", data[i : i + 4])
                i += 4
                if field == 4:
                    out["speed_mps"] = val
                elif field == 5:
                    out["accel"] = val
                elif field == 6:
                    out["steer"] = val
            elif wtype == 1:
                if i + 8 > n:
                    break
                (val,) = struct.unpack("<d", data[i : i + 8])
                i += 8
                if field == 11:
                    out["lat"] = val
                elif field == 12:
                    out["lon"] = val
                elif field == 13:
                    out["heading"] = val
            elif wtype == 2:
                ln, i = _decode_varint(data, i)
                i += ln
            else:
                break
    except Exception:
        return None
    if not out:
        return None
    return out


def _strip_emulation(data: bytes) -> bytes:
    stripped = bytearray()
    zeros = 0
    for b in data:
        if zeros >= 2 and b == 0x03:
            zeros = 0
            continue
        stripped.append(b)
        zeros = 0 if b != 0 else zeros + 1
    return bytes(stripped)


def _proto_from_nal(nal: bytes) -> Optional[bytes]:
    if len(nal) < 8:
        return None
    for i in range(3, len(nal) - 1):
        b = nal[i]
        if b == 0x42:
            continue
        if b == 0x69 and i > 2:
            return _strip_emulation(nal[i + 1 : -1])
        break
    return None


def _find_mdat(fp) -> Tuple[int, int]:
    fp.seek(0)
    while True:
        header = fp.read(8)
        if len(header) < 8:
            raise RuntimeError("mdat not found")
        size32, atom = struct.unpack(">I4s", header)
        if size32 == 1:
            large = fp.read(8)
            atom_size = struct.unpack(">Q", large)[0]
            hdr = 16
        else:
            atom_size = size32 if size32 else 0
            hdr = 8
        if atom == b"mdat":
            payload = atom_size - hdr if atom_size else 0
            return fp.tell(), payload
        if atom_size < hdr:
            raise RuntimeError("bad atom")
        fp.seek(atom_size - hdr, 1)


def _iter_sei_nals(fp, offset: int, size: int):
    fp.seek(offset)
    consumed = 0
    while size == 0 or consumed < size:
        header = fp.read(4)
        if len(header) < 4:
            break
        nal_size = struct.unpack(">I", header)[0]
        if nal_size < 2 or nal_size > 8_000_000:
            if 0 < nal_size < 50_000_000:
                fp.seek(nal_size, 1)
                consumed += 4 + nal_size
                continue
            break
        first = fp.read(2)
        if len(first) != 2:
            break
        h264_sei = (first[0] & 0x1F) == 6 and first[1] == 5
        hevc_type = (first[0] >> 1) & 0x3F
        hevc_sei = hevc_type in (39, 40)
        if not h264_sei and not hevc_sei:
            fp.seek(nal_size - 2, 1)
            consumed += 4 + nal_size
            continue
        rest = fp.read(nal_size - 2)
        if len(rest) != nal_size - 2:
            break
        consumed += 4 + nal_size
        yield first + rest


def extract_file(path: Path, max_samples: int = 4000) -> List[Dict[str, Any]]:
    """Return downsampled telemetry samples for one MP4 (time in seconds)."""
    samples: List[Dict[str, Any]] = []
    try:
        with open(path, "rb") as fp:
            offset, size = _find_mdat(fp)
            raw: List[Dict[str, Any]] = []
            for nal in _iter_sei_nals(fp, offset, size):
                payload = _proto_from_nal(nal)
                if not payload:
                    continue
                meta = parse_sei_metadata(payload)
                if meta:
                    raw.append(meta)
    except Exception:
        return []

    if not raw:
        return []

    n = len(raw)
    # Estimate fps from sample count vs typical 60s Tesla clip, fallback 36.
    fps = 36.0
    if n > 10:
        fps = max(10.0, min(48.0, n / 60.0 if n > 80 else 36.0))
        # If clearly a short clip (~n/36 seconds)
        fps = 36.0

    stride = max(1, n // max_samples)
    last_sig = None
    kept = 0
    for i, meta in enumerate(raw):
        sig = (meta.get("ap"), meta.get("brake"), meta.get("blink_l"), meta.get("blink_r"), meta.get("gear"))
        keep = (i % stride == 0) or (sig != last_sig) or i == n - 1
        last_sig = sig
        if not keep:
            continue
        sample = {
            "t": round(i / fps, 3),
            "speed": round(float(meta.get("speed_mps") or 0) * 3.6, 1),
            "accel": round(float(meta.get("accel") or 0), 3),
            "steer": round(float(meta.get("steer") or 0), 2),
            "brake": bool(meta.get("brake")),
            "ap": meta.get("ap") or "NONE",
            "gear": meta.get("gear") or "P",
            "bl": bool(meta.get("blink_l")),
            "br": bool(meta.get("blink_r")),
        }
        samples.append(sample)
        kept += 1
        if kept >= max_samples:
            break
    return samples


def cache_path_for(video: Path, cache_root: Path) -> Path:
    st = video.stat()
    key = f"{video.resolve()}|{st.st_mtime_ns}|{st.st_size}"
    digest = __import__("hashlib").sha1(key.encode()).hexdigest()
    return cache_root / "telemetry" / f"{digest}.json"


def extract_cached(video: Path, cache_root: Path) -> List[Dict[str, Any]]:
    if not video.is_file():
        return []
    dest = cache_path_for(video, cache_root)
    if dest.is_file():
        try:
            return json.loads(dest.read_text(encoding="utf-8"))
        except Exception:
            pass
    samples = extract_file(video)
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(samples, separators=(",", ":")), encoding="utf-8")
    except OSError:
        pass
    return samples
