#!/usr/bin/env python3
"""Turn off FLC lights stuck ON in HA during daytime (stale RTC state sync)."""
from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

TOKEN_PATH = Path("/config/.eufy_deploy_token")
FLC_LIGHTS = [
    ("light.back_left_flc_light", "switch.back_left_flc_light"),
    ("light.front_yard_flc_light", "switch.front_yard_flc_light"),
    ("light.garage_flc_light", "switch.garage_flc_light"),
    ("light.garage_side_flc_light", "switch.garage_side_flc_light_2"),
    ("light.walkout_flc_light", "switch.walkout_flc_light"),
]


def api_get(path: str) -> dict:
    token = TOKEN_PATH.read_text(encoding="utf-8").strip()
    req = urllib.request.Request(
        f"http://127.0.0.1:8123/api/{path}",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


def turn_off(domain: str, entity_id: str) -> None:
    token = TOKEN_PATH.read_text(encoding="utf-8").strip()
    body = json.dumps({"entity_id": entity_id}).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:8123/api/services/{domain}/turn_off",
        data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        print(f"{entity_id} turn_off -> {resp.status}")


def force_light_off(entity_id: str) -> None:
    """Force HA state when turn_off command succeeds but property sync does not update."""
    token = TOKEN_PATH.read_text(encoding="utf-8").strip()
    body = json.dumps({"state": "off"}).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:8123/api/states/{entity_id}",
        data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        print(f"{entity_id} REST state off -> {resp.status}")


def main() -> int:
    fixed = 0
    for light_id, switch_id in FLC_LIGHTS:
        state = api_get(f"states/{light_id}")
        if state.get("state") == "on":
            turn_off("switch", switch_id)
            turn_off("light", light_id)
            time.sleep(4)
            after = api_get(f"states/{light_id}")
            if after.get("state") == "on":
                turn_off("switch", switch_id)
                turn_off("light", light_id)
                time.sleep(4)
                after = api_get(f"states/{light_id}")
            if after.get("state") == "on":
                try:
                    force_light_off(light_id)
                    after = api_get(f"states/{light_id}")
                except urllib.error.HTTPError as exc:
                    print(f"{light_id} force off skipped ({exc.code})")
            print(f"{light_id} was on -> now {after.get('state')}")
            fixed += 1
        else:
            print(f"{light_id} ok ({state.get('state')})")
    print(f"fixed {fixed} stale FLC light(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
