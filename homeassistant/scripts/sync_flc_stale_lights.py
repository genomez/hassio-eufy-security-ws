#!/usr/bin/env python3
"""Sync FLC light entities when HA state is stale vs hub/physical.

Modes:
  default / daytime: only during sensor.outside_lighting_period == daytime
  --after-ha-start: run anytime after HA boot; skip garage FLC while porch schedule is on
"""
from __future__ import annotations

import json
import sys
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


def api_post(path: str, data: dict) -> None:
    token = TOKEN_PATH.read_text(encoding="utf-8").strip()
    body = json.dumps(data).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:8123/api/{path}",
        data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        resp.read()


def turn_off(domain: str, entity_id: str) -> None:
    api_post(f"services/{domain}/turn_off", {"entity_id": entity_id})
    print(f"{entity_id} turn_off")


def force_light_off(entity_id: str) -> None:
    """Force HA state when turn_off command succeeds but property sync does not update."""
    cur = api_get(f"states/{entity_id}")
    attrs = dict(cur.get("attributes") or {})
    api_post(f"states/{entity_id}", {"state": "off", "attributes": attrs})
    print(f"{entity_id} REST state off")


def main() -> int:
    ha_start = "--after-ha-start" in sys.argv
    period = api_get("states/sensor.outside_lighting_period").get("state")
    if not ha_start and period != "daytime":
        print(f"skip stale FLC sync during {period}")
        return 0

    # Cancel motion ON verifies so they cannot re-light after sync.
    for s in (
        "script.eufy_flc_motion_front_on_verify",
        "script.eufy_flc_motion_side_on_verify",
        "script.eufy_flc_motion_back_on_verify",
        "script.eufy_flc_overnight_on_verify",
    ):
        try:
            api_post("services/script/turn_off", {"entity_id": s})
        except Exception as exc:
            print(f"cancel {s}: {exc}")

    porch_on = api_get("states/binary_sensor.outside_lighting_evening").get("state") == "on"
    schedule_on = api_get("states/schedule.front_lights_schedule").get("state") == "on"
    # Evening porch owns garage: never force it off; restore ON if HA left it off.
    garage_owned_by_porch = ha_start and porch_on and schedule_on

    fixed = 0
    for light_id, switch_id in FLC_LIGHTS:
        if garage_owned_by_porch and light_id == "light.garage_flc_light":
            state = api_get(f"states/{light_id}")
            if state.get("state") == "on":
                print(f"{light_id} ok (evening porch schedule)")
            else:
                try:
                    api_post(
                        "services/script/eufy_flc_turn_on_with_verify",
                        {"entity_id": light_id, "max_attempts": 3},
                    )
                    print(f"{light_id} restored on (evening porch schedule)")
                except Exception as exc:
                    try:
                        api_post("services/light/turn_on", {"entity_id": light_id})
                        api_post("services/switch/turn_on", {"entity_id": switch_id})
                        print(f"{light_id} turn_on fallback ({exc})")
                    except Exception as exc2:
                        print(f"{light_id} evening restore failed ({exc2})")
                fixed += 1
            continue
        state = api_get(f"states/{light_id}")
        if state.get("state") != "on":
            print(f"{light_id} ok ({state.get('state')})")
            continue
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
                force_light_off(switch_id)
                after = api_get(f"states/{light_id}")
            except Exception as exc:
                print(f"{light_id} force off skipped ({exc})")
        print(f"{light_id} was on -> now {after.get('state')}")
        fixed += 1
    print(f"fixed {fixed} stale FLC light(s) ha_start={ha_start}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
