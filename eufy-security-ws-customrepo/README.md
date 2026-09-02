# eufy-security-ws-customrepo

**Maintainer:** [genomez](https://github.com/genomez). **`eufy-security-ws-customrepo`** pattern from [MELSAID888](https://github.com/MELSAID888/hassio-eufy-security-ws-customrepo); extended for T9000 on [bropat/hassio-eufy-security-ws](https://github.com/bropat/hassio-eufy-security-ws).

Home Assistant add-on that builds **eufy-security-ws 3.0.1** (bropat) with:

- Custom **eufy-security-client** from GitHub (`genomez/eufy-security-client#T9000-testing`)
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

Version `3.0.18-wake-v5` makes RTC handoff connection and timeout completion a
single observed promise. A failed or slow replacement connection can no longer
leave an orphaned `T9000 RTC handoff timeout` rejection that terminates Node;
the working RTC session is retained for the normal retry/fallback path.

Version `3.0.18-wake-v6` gives each RTC session its own SCTP/WASM module and
releases that module when the session closes. This prevents fixed-heap SCTP
state from accumulating across repeated proactive handoffs, while preserving
the established answerer mode, 800-byte SCTP packet size, and handoff timing.

Version `3.0.18-wake-v7` retries Mega push registration once when the cached
identity or signature is rejected, then persists the refreshed Mega session
after success. Mega account identifiers are also removed from client logs.
