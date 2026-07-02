# HomeBase Professional S1 (T9000) — Home Assistant setup guide

Community-tested setup for **Eufy HomeBase Professional S1 (T9000)** with Home Assistant after Eufy’s **eufy_mega** cloud migration broke motion events on the stock stack.

This is **not** an official Eufy or bropat release. It is a maintained fork pair built from real-world testing on production hardware.

## What you get

Tested on production T9000 hardware (eufy_mega account, US region):

| Feature | Status |
|---------|--------|
| Motion events in HA | Working (T9000 P2P push cmds 1317/1318) |
| Live thumbnail updates | Working |
| Person / face names in HA | Working (`nick_name` → `person_name` mapping) |
| Automations on motion / person | Working |
| Guard mode changes from HA | Working |
| Per-camera privacy (`enabled` switch) | Working — e.g. privacy on arrive, recording on leave |
| Floodlight / device control | Working |

**Example automation pattern:** arm/disarm or change guard mode when leaving/arriving, and toggle `switch.<camera>_enabled` (off = privacy on, on = camera active) for individual cameras such as an indoor cam in a private area.

## Why not the stock add-on?

The official **bropat** add-on + npm client does **not** cover T9000 motion after the eufy_mega migration:

| Gap | What this fork does |
|-----|---------------------|
| eufy_mega accounts need v6 login + mega FCM registration | Mega login patch + client support ([issue #933](https://github.com/bropat/eufy-security-client/issues/933)) |
| T9000 motion is **not** HB3 FCM cmd 2037 | Handles P2P station push **1317/1318** with base64 inner payload |
| T9000 station type not in stock client | `HOMEBASE_PROFESSIONAL_S1` (device type 27) support |

If you are on a T9000, you need this fork pair — not a limitation of the setup once installed.

## Architecture

Three layers — use **all three**:

| Layer | Maintainer | Source | Notes |
|-------|------------|--------|-------|
| **HA integration** | [fuatakgun](https://github.com/fuatakgun) | [fuatakgun/eufy_security](https://github.com/fuatakgun/eufy_security) via HACS | Standard community integration (e.g. v8.2.4). **Do not** use a custom HA integration fork for T9000. |
| **WebSocket add-on** | [genomez](https://github.com/genomez) | [genomez/hassio-eufy-security-ws](https://github.com/genomez/hassio-eufy-security-ws) → **`eufy-security-ws-customrepo`** | **Install this add-on**, not bropat’s stock `eufy-security-ws`. Builds `eufy-security-ws` 3.0.1 with mega login patch + custom client. |
| **Client library** | [genomez](https://github.com/genomez) | [genomez/eufy-security-client](https://github.com/genomez/eufy-security-client) branch **`T9000-testing`** | T9000 station type, mega v6 login, P2P push 1317/1318 |

**Upstream (reference only for T9000):** [bropat](https://github.com/bropat) maintains the original [hassio-eufy-security-ws](https://github.com/bropat/hassio-eufy-security-ws), [eufy-security-ws](https://github.com/bropat/eufy-security-ws), and [eufy-security-client](https://github.com/bropat/eufy-security-client). The **`eufy-security-ws-customrepo`** add-on pattern (git-pinned client via `build.yaml`) came from [MELSAID888/hassio-eufy-security-ws-customrepo](https://github.com/MELSAID888/hassio-eufy-security-ws-customrepo) and was incorporated into this repo with T9000 client, mega login, and Node 24 build fixes.

```
Eufy cloud (eufy_mega) ──► add-on (eufy-security-ws + custom client)
                                │
T9000 P2P push (1317/1318) ─────┤──► WebSocket :3000
                                │
                                └──► fuatakgun/eufy_security (HACS) ──► Home Assistant
```

## Requirements

- Home Assistant **OS** or **Supervised** (add-on support)
- **HomeBase Professional S1 (T9000)** with cameras paired to it
- Eufy account on the **eufy_mega** backend (most accounts migrated mid-2026; symptom: Eufy app works but HA motion went silent)
- **HACS** installed for the integration
- `amd64` or `aarch64` host (other arches are not built/tested in this fork)

## 1. Install the custom add-on repository

1. **Settings → Add-ons → Add-on store → ⋮ → Repositories**
2. Add:

   ```
   https://github.com/genomez/hassio-eufy-security-ws
   ```

3. **Check for updates** (or reload the store)
4. Install **`eufy-security-ws-customrepo`** (not the stock `eufy-security-ws` entry from this repo)

### What this add-on builds

Pinned in `eufy-security-ws-customrepo/build.yaml`:

| Build arg | Value |
|-----------|-------|
| `EUFY_SECURITY_WS_VERSION` | `3.0.1` |
| `EUFY_SECURITY_CLIENT_GIT` | `github:genomez/eufy-security-client#T9000-testing` |
| `EUFY_CLIENT_BUILD_ID` | `p2p-nickname` (Docker cache buster) |

The Dockerfile clones and **always rebuilds** the client from GitHub (no stale cached client). It also applies `eufy-security-ws-mega-login.patch` so **v6 mega login** runs automatically on startup.

## 2. Configure the add-on

Example configuration:

```yaml
username: your@email.com
password: your_eufy_password
country: US
port: 3000
polling_interval: 10
accept_invitations: true
debug: false
ipv4first: false
event_duration: 10
stations:
  - serial_number: T9000PXXXXXXXXXXX
    ip_address: 192.168.1.100
```

### Important options

| Option | Recommendation |
|--------|----------------|
| **`stations`** | Strongly recommended for T9000. Set the base **serial number** and **LAN IP** (or subnet broadcast, e.g. `192.168.1.255`). Speeds P2P discovery and helps device control. |
| **`debug`** | `false` for normal use. Enable only when troubleshooting — logs are very verbose. |
| **`ipv4first`** | Try `true` if push registration fails with endless `create push credentials error` (IPv6 Firebase issue). |
| **`country`** | ISO 3166-1 alpha-2 code matching your Eufy account region. |

### First startup — mega login / 2FA

On first run (or after session expiry), the add-on may prompt for:

- **Email verification code** (mega 2FA) — enter via the add-on UI / integration flow
- **Captcha** — follow on-screen prompts

When successful, logs should include:

```
v6 mega login: session ready
v6 push: FCM token registered on the eufy_mega backend
Connected to station T9000… on host <ip> and port <port>
Push notification connection successfully established
```

The mega session is persisted under `/data` and typically survives restarts for ~30 days.

## 3. Install the Home Assistant integration

1. In **HACS → Integrations**, add [fuatakgun/eufy_security](https://github.com/fuatakgun/eufy_security)
2. Install a recent stable release (tested with **v8.2.4**)
3. **Settings → Devices & services → Add integration → Eufy Security**
4. Point it at the add-on WebSocket (`host:3000` — default if on same HA host)

No custom integration fork is required.

## 4. Verify it works

### Startup checklist

After **Update** or **Rebuild** + **Start**, confirm in the add-on log:

- [ ] `Eufy Security server listening on host 0.0.0.0, port 3000`
- [ ] `v6 mega login: session ready`
- [ ] `v6 push: FCM token registered on the eufy_mega backend`
- [ ] `Connected to station T9000…` (your serial)

### Motion and privacy test

1. Walk in front of a T9000-connected camera — motion binary sensor and thumbnail should update.
2. Person sensor should show a name (not `Unknown`) when face recognition fires in the Eufy app.
3. Toggle **Camera enabled** (`switch.<camera>_enabled`) — off enables privacy mode, on restores recording. Requires `Connected to station T9000…` in logs (use **`stations`** IP hints if control commands fail).

### Supervisor build log (optional)

During **Rebuild**, open **Settings → System → Logs → Supervisor** and confirm the build arg:

```
EUFY_SECURITY_CLIENT_GIT=github:genomez/eufy-security-client#T9000-testing
```

## Updating

| Change | Action |
|--------|--------|
| New commits on `T9000-testing` | Add-on **Update** or **Rebuild** (Rebuild if Docker cache is stubborn) |
| New add-on repo commit | **Check for updates** on the repository, then update the add-on |
| Integration only | Update via HACS — independent of the add-on |

Prefer **Update** over **Rebuild** when the installed version already matches the repo; use **Rebuild** after Dockerfile / `EUFY_CLIENT_BUILD_ID` changes.

## Caveats

### Setup-dependent (not T9000-specific bugs)

- **`stations` IP hints** — strongly recommended. P2P control (privacy, some device commands) needs a reliable path to the T9000 on your LAN. Symptom: `All address lookup tentatives failed` in logs.
- **eufy_mega login** — first startup may require email 2FA or captcha; session is cached under `/data`.
- **Limited test matrix** — validated on US eufy_mega, `amd64`/`aarch64`. Other regions, camera models, and arches may differ.

### Maintenance outlook

[bropat/eufy-security-client](https://github.com/bropat/eufy-security-client) is a **temporary stopgap** while a new Eufy Mega integration is planned. This fork may lag upstream `master`; T9000-specific work lives in `genomez/eufy-security-client`. Expect community maintenance, not official Eufy support.

## Troubleshooting

| Symptom | Things to check |
|---------|-----------------|
| No motion at all | Mega login lines missing? Rebuild add-on. Confirm `v6 push: FCM token registered`. |
| Thumbnails only update on add-on restart | Same as above — cloud sync works but live push path does not. |
| `Connected to station T9000` missing | Add **`stations`** with correct serial + IP. Same VLAN as HA. |
| Person shows `Unknown` | Ensure add-on built with `p2p-nickname` / latest `T9000-testing` (`nick_name` mapping). |
| Privacy / guard toggle does nothing | Confirm `Connected to station T9000…` in log. Add **`stations`** serial + LAN IP. |
| Build uses wrong client | Supervisor log must show `EUFY_SECURITY_CLIENT_GIT=…#T9000-testing`. Rebuild without cache. |

Enable **`debug: true`** briefly, reproduce one motion event, then turn debug off.

## Technical background (for contributors)

Key client commits on `T9000-testing` (`237c9aa`):

1. **T9000 station support** — `device_type` 27, P2P cloud IP fixes
2. **eufy_mega v6 login** — `MegaHTTPApi`, FCM re-registration after mega session ([upstream PR #939](https://github.com/bropat/eufy-security-client/pull/939) equivalent)
3. **P2P push 1317/1318** — motion, thumbnails, `nick_name` → `person_name`; HB3 cmd 2037 parity where applicable

**Contributor note:** An early experiment inferred motion from T9000 grid state (inner cmd 9243, `cur_video_state`). It was superseded by 1317/1318 and is intentionally off (`HOME_BASE_S1_GRID_MOTION_ENABLED = false` in `homebaseS1Grid.ts`) — it caused duplicate/false events during testing.

Related upstream context:

- [Issue #933](https://github.com/bropat/eufy-security-client/issues/933) — mega migration broke FCM event delivery
- [PR #913](https://github.com/bropat/eufy-security-client/pull/913) — thumbnail v2 decode (included in fork base)

## Repositories (canonical list)

| Maintainer | Repo | Role |
|------------|------|------|
| **genomez** | https://github.com/genomez/hassio-eufy-security-ws | Add-on repo — install **`eufy-security-ws-customrepo`** |
| **genomez** | https://github.com/genomez/eufy-security-client | Client library (`T9000-testing` / `master`) |
| **fuatakgun** | https://github.com/fuatakgun/eufy_security | HA integration (HACS) |
| bropat *(upstream)* | https://github.com/bropat/hassio-eufy-security-ws | Original add-on repo — **not** used for T9000 |
| bropat *(upstream)* | https://github.com/bropat/eufy-security-client | Original client — **not** used for T9000 |
| MELSAID888 *(customrepo origin)* | https://github.com/MELSAID888/hassio-eufy-security-ws-customrepo | Earlier **`eufy-security-ws-customrepo`** pattern — **use genomez repo instead** |

There is **no** separate `genomez/eufy_security` fork — use fuatakgun from HACS.

### Coming from MELSAID888’s customrepo?

If you previously installed [MELSAID888/hassio-eufy-security-ws-customrepo](https://github.com/MELSAID888/hassio-eufy-security-ws-customrepo) (manual copy under `/addons/` or a local fork), switch to **`https://github.com/genomez/hassio-eufy-security-ws`** as the add-on repository. This repo keeps the same **`eufy-security-ws-customrepo`** slug but adds the T9000 client pin, eufy_mega auto-login, and production-tested `build.yaml` / Dockerfile.

## Reporting issues

Include:

- Add-on version (`3.0.1-p2p-nickname` or current `config.yaml` version)
- Client branch + short commit (`git rev-parse --short HEAD` on `T9000-testing`)
- Whether mega login + FCM registration lines appear
- T9000 serial, camera model, and anonymized log excerpt around one motion event

Open issues on the repo that matches the layer: add-on → `genomez/hassio-eufy-security-ws`, client/T9000 protocol → `genomez/eufy-security-client`, HA entities/automations → `fuatakgun/eufy_security`.

---

*Tested on production T9000 hardware with eufy_mega accounts. Community contribution — not affiliated with Anker/Eufy.*
