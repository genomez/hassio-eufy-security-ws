# eufy-security-ws-customrepo

**Maintainer:** [genomez](https://github.com/genomez). **`eufy-security-ws-customrepo`** pattern from [MELSAID888](https://github.com/MELSAID888/hassio-eufy-security-ws-customrepo); extended for T9000 on [bropat/hassio-eufy-security-ws](https://github.com/bropat/hassio-eufy-security-ws).

Home Assistant add-on that builds **eufy-security-ws 3.0.1** (bropat) with:

- Custom **eufy-security-client** from GitHub (`genomez/eufy-security-client#regional-rtc-handoff-diagnostic-v2`)
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

## Regional RTC candidate

Version `3.0.18-regional-rtc-rc2` is an opt-in validation candidate based on
`wake-v6`. It adds compatibility for both flat and nested passport-profile
responses and, for country `FR`, uses Eufy's EU RTC host, portal-compatible sign
headers, and `EU` in the WebSocket authentication payload. Other countries keep
their existing signaling defaults. Empty or NUL-padded-empty inbound database
payloads are ignored without producing a misleading JSON parse warning.

Version `3.0.18-wake-v6` gives each RTC session its own SCTP/WASM module and
releases that module when the session closes. This prevents fixed-heap SCTP
state from accumulating across repeated proactive handoffs, while preserving
the established answerer mode, 800-byte SCTP packet size, and handoff timing.

## Regional handoff diagnostic

Version `3.0.18-regional-handoff-test1` is an isolated reporter test based on
`3.0.18-regional-rtc-rc2`. It adds process-local handoff IDs and sanitized
replacement-session phase markers from sign retrieval through WebSocket auth,
peer/SDP setup, and command-channel opening. An outer 45-second watchdog is
armed before the replacement connection starts; if the inner lifecycle does
not settle, only the replacement session is closed and the working original
session is retained. A `finally` marker records terminal cleanup for every
handoff attempt.

Version `3.0.18-regional-handoff-test2` follows the FR/EU test1 result that
stopped at `fetch_sign_start` while the original RTC command session remained
healthy. It adds a 15-second abortable sign request with sanitized request,
response-header, body-read, rejection, and abort phases; a five-second
monotonic handoff heartbeat with event-loop lag; and a separate station-level
50-second absolute deadline. Either deadline closes only the replacement and
retains the working original session for the existing probe/retry path.

The diagnostic does not change regional endpoint selection, authentication
data, SCTP packet size, answerer/client-offer mode, proactive handoff timing,
property refresh, or Mega retry/throttle behavior.
