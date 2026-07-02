# eufy-security-ws Home Assistant add-on repository (T9000 fork)

Fork of [bropat/hassio-eufy-security-ws](https://github.com/bropat/hassio-eufy-security-ws) with a custom add-on that builds [genomez/eufy-security-client](https://github.com/genomez/eufy-security-client) for **HomeBase Professional S1 (T9000)** support after the **eufy_mega** cloud migration.

## T9000 setup guide

**→ [T9000-SETUP.md](T9000-SETUP.md)** — full install, configuration, verification, and troubleshooting.

### What works (community-tested)

Motion, live thumbnails, person/face names, guard mode, per-camera privacy, floodlights, and HA automations — on T9000 with an eufy_mega account. See the guide for requirements and caveats.

### Quick reference

| Component | Maintainer | Source |
|-----------|------------|--------|
| Add-on repository | **genomez** | `https://github.com/genomez/hassio-eufy-security-ws` |
| Add-on to install | **genomez** | **`eufy-security-ws-customrepo`** (not bropat’s `eufy-security-ws`) |
| Client library branch | **genomez** | `genomez/eufy-security-client#T9000-testing` |
| HA integration (HACS) | **fuatakgun** | [fuatakgun/eufy_security](https://github.com/fuatakgun/eufy_security) |
| Upstream reference | bropat | [bropat/hassio-eufy-security-ws](https://github.com/bropat/hassio-eufy-security-ws), [bropat/eufy-security-client](https://github.com/bropat/eufy-security-client) |
| Customrepo pattern | MELSAID888 | [hassio-eufy-security-ws-customrepo](https://github.com/MELSAID888/hassio-eufy-security-ws-customrepo) (incorporated here) |

## Add-ons in this repository

### [eufy-security-ws-customrepo](./eufy-security-ws-customrepo/) — **use this for T9000**

Maintained by **genomez**. Evolved from [MELSAID888/hassio-eufy-security-ws-customrepo](https://github.com/MELSAID888/hassio-eufy-security-ws-customrepo) (custom client via `build.yaml`) with T9000 client pin, mega login patch, and Node 24 build. Version `3.0.1-p2p-nickname`.

### [eufy-security-ws](./eufy-security-ws/)

Upstream-style add-on from **bropat**’s lineage (stock npm client). Included for reference; **not** used for T9000.

## Installation

1. **Settings → Add-ons → Add-on store → ⋮ → Repositories**
2. Add `https://github.com/genomez/hassio-eufy-security-ws`
3. Install **eufy-security-ws-customrepo**
4. Follow [T9000-SETUP.md](T9000-SETUP.md) for configuration and the HACS integration

## Issues

- T9000 / motion / push / client: [genomez/eufy-security-client](https://github.com/genomez/eufy-security-client/issues)
- Add-on build / mega login: [genomez/hassio-eufy-security-ws](https://github.com/genomez/hassio-eufy-security-ws/issues)
- HA entities / automations: [fuatakgun/eufy_security](https://github.com/fuatakgun/eufy_security/issues)

## Upstream

Based on [bropat/hassio-eufy-security-ws](https://github.com/bropat/hassio-eufy-security-ws). **`eufy-security-ws-customrepo`** pattern from [MELSAID888/hassio-eufy-security-ws-customrepo](https://github.com/MELSAID888/hassio-eufy-security-ws-customrepo). Client library upstream: [bropat/eufy-security-client](https://github.com/bropat/eufy-security-client) (deprecated stopgap; T9000 work lives in [genomez/eufy-security-client](https://github.com/genomez/eufy-security-client)).
