# eufy-security-ws-customrepo

> **Opt-in compatibility test:** This branch builds
> `genomez/eufy-security-client#passport-profile-response-compat-v4` to test
> flat and nested regional passport-profile responses plus bounded, redacted
> first-boot Mega diagnostics with an explicit post-connect fallback. It is
> separate from the normal `wake-v4` add-on and is not intended as a general
> update.

**Maintainer:** [genomez](https://github.com/genomez). **`eufy-security-ws-customrepo`** pattern from [MELSAID888](https://github.com/MELSAID888/hassio-eufy-security-ws-customrepo); extended for T9000 on [bropat/hassio-eufy-security-ws](https://github.com/bropat/hassio-eufy-security-ws).

Home Assistant add-on that builds **eufy-security-ws 3.0.1** (bropat) with:

- Custom **eufy-security-client** from GitHub (`genomez/eufy-security-client#passport-profile-response-compat-v4`)
- Bounded Mega bootstrap requests with redacted stage diagnostics and no automatic login retry
- Once-guarded post-connect bootstrap fallback when the driver event is not emitted
- Automatic **eufy_mega v6** login (mega-login patch)
- Persistent T9000 Mega/WebRTC command transport with make-before-break handoff
- Hub-authoritative property/FLC synchronization and guarded RTC recovery
- **Node 24** base image

## T9000 (HomeBase Professional S1)

**Full setup guide:** [T9000-SETUP.md](../T9000-SETUP.md)

Quick start:

1. Add repository `https://github.com/genomez/hassio-eufy-security-ws`
2. Install this add-on (**eufy-security-ws-customrepo**)
3. Configure Eufy credentials; **`stations`** IP hints remain useful for legacy P2P stations
4. Install [fuatakgun/eufy_security](https://github.com/fuatakgun/eufy_security) via HACS and connect to `host:3000`

Version `3.0.18-wake-v4` also prevents an early RTC signaling failure from
leaving an unhandled TURN-harvest timeout that can terminate the add-on.
