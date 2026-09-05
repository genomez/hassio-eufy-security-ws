# eufy-security-ws-customrepo

**Maintainer:** [genomez](https://github.com/genomez). **`eufy-security-ws-customrepo`** pattern from [MELSAID888](https://github.com/MELSAID888/hassio-eufy-security-ws-customrepo); extended for T9000 on [bropat/hassio-eufy-security-ws](https://github.com/bropat/hassio-eufy-security-ws).

Home Assistant add-on that builds **eufy-security-ws 3.0.1** (bropat) with:

- Custom **eufy-security-client** from GitHub (`genomez/eufy-security-client#regional-rtc-stable-rc3-build`)
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

Version `3.0.18-regional-auth-test3` is an isolated reporter-only follow-up for
the exact sign-endpoint failure `HTTP 401` where the Mega token no longer
exists because it was kicked out. On an initial disconnected RTC attempt only,
it verifies that no T9000 RTC session is connected, creates a local persistence
backup, records a 24-hour cooldown, and removes only the root stale Mega
session. It then invokes the add-on's normal Mega login flow so any email code
or captcha is handled through Home Assistant. A successful login installs the
fresh RTC credentials and resumes the blocked T9000 connection. Recovery is
single-flight and fail-closed; unrelated 401 responses, ordinary RTC failures,
and proactive handoffs do not reset authentication. Logs contain status and
phase markers, not tokens or authentication payloads.

Version `3.0.18-regional-offer-test4` adds a sanitized terminal classifier for
initial RTC timeouts. It distinguishes a missing hub SDP offer, SDP followed by
ICE with no selected pair, and a selected pair without an open command channel.
Only the exact missing-offer state after `scall` status 100 and peer
initialization can trigger one guarded cloud inventory wake and one clean retry
in answerer mode. The retry is opt-in in the client and enabled only by this
diagnostic image; successful connection resets its one-shot guard. Test4
explicitly disables the inherited Test3 Mega-auth recovery, so a revoked-token
condition fails closed without changing persistence or starting a login.

Version `3.0.18-regional-app-live-test5` follows the Test4 result where an
applied inventory wake still ended before the hub supplied SDP. On the first
exact `no_hub_sdp_offer` result, Test5 suppresses automatic reconnect, cloud,
swipe/TURN, and Mega-auth recovery paths. It emits timed markers for one
official-app live view, asks for that view to be closed, waits briefly, and
makes exactly one answerer-mode RTC retry. A non-matching initial failure or a
failed post-app retry stops without another automatic attempt. Closing the
station cancels the observation timers.

Version `3.0.18-regional-rtc-rc3` packages the proven regional RTC, guarded
revoked-Mega-session recovery, and Test5 logic under one stable add-on identity.
Guarded recovery is enabled by default and remains limited to the typed revoked-token
condition while no T9000 RTC session is connected. The Test5 live-view experiment is
dormant by default; set the add-on option `rtc_app_live_view_test` to `true` only for
the single controlled run. While enabled, competing cloud and swipe/live wake paths
are suppressed. Setting the option back to `false` restores normal RC3 reconnect and
wake behavior without switching repositories or changing the add-on data directory.

The diagnostic does not change regional endpoint selection, SCTP packet size,
answerer/client-offer mode, proactive handoff timing, property refresh, or the
existing Mega login lockout behavior.
