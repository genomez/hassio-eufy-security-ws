#!/usr/bin/env python3
"""Align dashboard snapshot times with cache metadata and HA image entities."""
from __future__ import annotations

import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

TOKEN_PATH = Path("/config/.eufy_deploy_token")
# The add-on publishes {serial: capture_iso} here on every event-image cache save/restore.
# HA Core can read /share directly, so we no longer need `docker exec` into the add-on
# (which silently failed because HA Core has no sudo/Docker access).
SNAPSHOT_TIMES_FILE = Path("/share/eufy/snapshot_times.json")
SLUGS = [
    "back_left_flc",
    "back_yard",
    "carport",
    "cars",
    "driveway",
    "entrance",
    "front_door",
    "front_porch",
    "front_yard_flc",
    "front_yard",
    "garage_flc",
    "garage_side_flc",
    "side_door",
    "walkout_flc",
]

CAMERAS = [
    ("back_left_flc", "Back Left FLC"),
    ("back_yard", "Back Yard"),
    ("carport", "Carport"),
    ("cars", "Cars"),
    ("driveway", "Driveway"),
    ("entrance", "Entrance"),
    ("front_door", "Front Door"),
    ("front_porch", "Front Porch"),
    ("front_yard_flc", "Front Yard FLC"),
    ("front_yard", "Front Yard"),
    ("garage_flc", "Garage FLC"),
    ("garage_side_flc", "Garage Side FLC"),
    ("side_door", "Side Door"),
    ("walkout_flc", "Walkout FLC"),
]


def parse_iso(value: str | None) -> datetime | None:
    if not value or value in ("unknown", "unavailable", ""):
        return None
    try:
        text = value.replace("Z", "+00:00")
        if "." in text:
            head, tail = text.split(".", 1)
            if "+" in tail:
                frac, tz = tail.split("+", 1)
                text = f"{head}+{tz}"
            elif "-" in tail[1:]:
                frac, tz = tail.split("-", 1)
                text = f"{head}-{tz}"
            else:
                text = head
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def slug_by_serial() -> dict[str, str]:
    registry = json.loads(Path("/config/.storage/core.device_registry").read_text(encoding="utf-8"))
    name_to_slug = {label.lower(): slug for slug, label in CAMERAS}
    name_to_slug["driveway "] = "driveway"
    name_to_slug["front porch"] = "front_porch"
    name_to_slug["entrance "] = "entrance"
    mapping: dict[str, str] = {}
    for device in registry["data"]["devices"]:
        name = (device.get("name") or "").strip().lower()
        slug = name_to_slug.get(name) or name_to_slug.get((device.get("name") or "").lower())
        if not slug:
            continue
        for ident in device.get("identifiers") or []:
            if isinstance(ident, list) and len(ident) == 2 and ident[0] == "eufy_security":
                mapping[ident[1]] = slug
    return mapping


def ha_states() -> dict[str, dict]:
    token = TOKEN_PATH.read_text(encoding="utf-8").strip()
    req = urllib.request.Request(
        "http://127.0.0.1:8123/api/states",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        states = json.loads(resp.read().decode())
    return {s["entity_id"]: s for s in states}


def ha_timezone() -> ZoneInfo:
    """The site timezone HA is configured with (e.g. America/Chicago)."""
    try:
        token = TOKEN_PATH.read_text(encoding="utf-8").strip()
        req = urllib.request.Request(
            "http://127.0.0.1:8123/api/config",
            headers={"Authorization": f"Bearer {token}"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            name = json.loads(resp.read().decode()).get("time_zone")
        if name:
            return ZoneInfo(name)
    except Exception:
        pass
    return ZoneInfo("UTC")


def localize(value: str | None, tz: ZoneInfo) -> str | None:
    """Interpret the add-on's naive wall-clock capture time in the site timezone.

    The event-image filename is the station's local wall-clock time. The add-on
    publishes it without an offset; we stamp the site tz here so HA gets the correct
    absolute instant (fixes "x ago", red recent-activity highlight, and sort order).
    Aware values (legacy +00:00 entries) are passed through unchanged.
    """
    if not value or value in ("unknown", "unavailable", ""):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    return dt.isoformat()


def load_meta_times() -> dict[str, str]:
    """Read the add-on's published {serial: capture_iso} map from the shared folder."""
    try:
        raw = json.loads(SNAPSHOT_TIMES_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (ValueError, OSError):
        return {}
    try:
        serial_to_slug = slug_by_serial()
    except Exception:
        serial_to_slug = {}
    payload: dict[str, str] = {}
    for serial, iso in raw.items():
        slug = serial_to_slug.get(serial)
        if slug and isinstance(iso, str) and iso:
            payload[slug] = iso
    return payload


def merged_times() -> dict[str, str]:
    """Cache metadata (the event-image filename time) is authoritative for capture time.

    The HA image entity's state timestamp only reflects when the add-on pushed the
    bytes to HA (bumped on every reconnect/restore), never when the frame was captured,
    so we only fall back to it when there is no cache entry at all.
    """
    by_id = ha_states()
    cache = load_meta_times()
    tz = ha_timezone()
    merged: dict[str, str] = {}
    for slug in SLUGS:
        iso = localize(cache.get(slug), tz)
        if not iso:
            image = by_id.get(f"image.{slug}_event_image", {})
            image_dt = parse_iso(image.get("state"))
            iso = image_dt.isoformat() if image_dt else None
        if iso:
            merged[slug] = iso
    return merged


def fire_event(payload: dict[str, str]) -> None:
    token = TOKEN_PATH.read_text(encoding="utf-8").strip()
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:8123/api/events/eufy_snapshot_sync",
        data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        print("event fired", resp.status, "cameras", len(payload))
    for slug, iso in sorted(payload.items()):
        print(f"  {slug}: {iso}")


def main() -> int:
    try:
        payload = merged_times()
    except Exception as exc:
        print(f"sync skipped: {exc}")
        return 0
    if not payload:
        print("No snapshot metadata found (addon may still be starting)")
        return 0
    try:
        fire_event(payload)
    except Exception as exc:
        print(f"event fire failed: {exc}")
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
