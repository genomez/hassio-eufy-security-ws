# Home Assistant companion layer

This folder holds the **Home Assistant–side** configuration that turns the
`eufy-security-ws-customrepo` add-on into a usable camera dashboard. It is **not**
part of the add-on container — these files run inside Home Assistant Core, call the
HA API, and read the data the add-on publishes to `/share`.

Keeping them here (rather than inside the add-on folder) means one `git clone` gives
you both the container source and the glue needed to reproduce the setup.

```
homeassistant/
├─ packages/
│  └─ eufy_security.yaml     # shell_command + automations + template sensors (one drop-in package)
└─ scripts/
   ├─ sync_eufy_snapshot_times.py   # publishes correct "last event" times to the dashboard
   └─ sync_flc_stale_lights.py      # daytime safeguard: clears floodlight lights stuck ON
```

## What it does

- The add-on writes each camera's last event-image capture time (device local
  wall-clock) to `/share/eufy/snapshot_times.json` on every event.
- `sync_eufy_snapshot_times.py` reads that file, localizes the times to your HA
  `time_zone`, and fires an `eufy_snapshot_sync` event.
- The `template:` sensors in the package latch each camera's last event
  type/time from that event (plus motion/person triggers) so the dashboard shows an
  accurate "x ago", sorts correctly, and highlights recent activity.
- The automations run the sync on HA start, on hub reconnect, every 5 minutes, and
  whenever a new event image arrives.

> Why a helper file on `/share` instead of reading the add-on directly? Home Assistant
> Core has no Docker access, so it cannot `docker exec` into the add-on. `/share` is
> mounted into both the add-on (via `map: share:rw`) and HA Core, so it is the shared
> hand-off point.

## Prerequisites

1. **The add-on** `eufy-security-ws-customrepo` installed and connected (this repo).
2. The **[eufy_security](https://github.com/fuatakgun/eufy_security) HACS integration**
   installed and logged in, so entities like `image.<cam>_event_image`,
   `binary_sensor.<cam>_motion_detected`, and `sensor.<cam>_person_name` exist.
3. A **long-lived access token** saved to `/config/.eufy_deploy_token` (the scripts use
   it to call the HA API):
   - Profile → Security → Long-lived access tokens → Create Token.
   - `echo -n "<TOKEN>" > /config/.eufy_deploy_token`

## Install

1. **Enable packages** in `configuration.yaml` (if not already):

   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```

2. **Copy the files:**

   ```bash
   cp homeassistant/packages/eufy_security.yaml   /config/packages/
   cp homeassistant/scripts/*.py                  /config/scripts/
   ```

3. **Customize for your cameras** — edit `/config/packages/eufy_security.yaml` and the
   two scripts to match *your* entity names. See "Customization" below.

4. **Restart Home Assistant** (or Developer Tools → YAML → check config, then reload
   Template Entities + Automations + Shell Commands).

## Customization (site-specific)

These files are wired to the author's entities and must be adapted:

- `packages/eufy_security.yaml` — the `template:` sensors reference specific camera
  **slugs** (e.g. `garage_flc`, `front_yard_flc`) and friendly names. Add/remove
  camera blocks to match your entities.
- `scripts/sync_eufy_snapshot_times.py` — the `SLUGS` and `CAMERAS` lists map camera
  slug → device name (looked up in the HA device registry). Update to your cameras.
- `scripts/sync_flc_stale_lights.py` — the `FLC_LIGHTS` list of
  `(light_entity, switch_entity)` pairs. Update or empty it if you do not use
  floodlight cams.

No timezone edits are needed — the sync reads HA's configured `time_zone` at runtime.

## Notes

- `sync_flc_stale_lights.py` is a daytime safeguard from before the add-on gained
  floodlight state persistence; it is optional and only acts on lights it finds stuck
  ON. Remove it (and drop it from the automations/shell_command) if you don't want it.
- If you previously wired these via `configuration.yaml`/`automations.yaml` +
  `eufy_templates/`, use the package **instead** to avoid duplicate `unique_id`s.

## T9000 / RTC reliability patterns (sanitized)

HomeBase Professional S1 (T9000) talks to HA over **local WebRTC**. The integration
often updates entities **optimistically** (HA shows the commanded state before the hub
acks). That can leave Guard Mode or floodlight lights wrong in HA even when the physical
device did not change.

These patterns are **generic recommendations** — rewrite entity IDs for your station and
cameras. Do not copy site-specific deploy scripts from private configs.

### 1. Prefer a debounced “connected” sensor

Raw `binary_sensor.<station>_connected` can flap for ~1–2 seconds during normal RTC
session refresh. Drive automations from a template binary sensor that requires `on`/`off`
for ~60 seconds before changing (a “stable connected” helper).

### 2. Verify Guard Mode changes

After `select.select_option` on the station guard-mode entity, **wait and re-check** a
second signal (usually `alarm_control_panel.<station>`) for the expected armed state.
Retry a few times if the panel never confirms. Do not trust the select entity alone.

Example shape (placeholders only):

```yaml
sequence:
  - repeat:
      count: 3
      sequence:
        - action: select.select_option
          target:
            entity_id: select.<station>_guard_mode
          data:
            option: Away   # or Home / your mode name
        - delay:
            seconds: 20
        - if:
            - condition: state
              entity_id: alarm_control_panel.<station>
              state: armed_away
          then:
            - stop: Hub confirmed Away
```

### 3. Verify floodlight (FLC) on/off

Same class of bug: HA can show `light.<cam>_flc_light` **off** while the lamp stays on.
For schedule / safety turn-offs:

1. Wait until stable connected is `on` (with a timeout).
2. Send `light.turn_off` and the matching `switch.*_flc_light` (names vary by camera).
3. Wait ~15s, optionally `homeassistant.update_entity`, then **send off again**.
4. Prefer **at least two off pulses** even if HA already reports `off` — optimistic
   state must not skip the hub command.
5. Log or notify if the light is still `on` after the last attempt.

Turn-on can stop early once HA reports `on`; turn-off should not.

### 4. Self-heal carefully

Restarting the add-on can recover a wedged RTC session, but:

- Trigger on **prolonged** stable-disconnect or clear failure signals — not on every
  brief raw flap.
- Debounce self-heal (e.g. not more than once every several minutes).
- Use a cooldown after supervisor rebuild/update so restart loops do not fight the
  supervisor.

### 5. What not to put in a public repo

Long-lived tokens, notify device IDs, person entity names, LAN IPs, and fully wired
home automations belong in **private** config. Publish patterns and example shapes
only, with `<station>` / `<cam>` placeholders.
