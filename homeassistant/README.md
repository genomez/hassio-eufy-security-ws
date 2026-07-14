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
