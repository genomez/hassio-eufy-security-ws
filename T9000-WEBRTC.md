# T9000 WebRTC control path (post–firmware 4.2.3.3)

Design notes for restoring **HomeBase Professional S1 (T9000)** control in Home Assistant after Eufy migrated off legacy TUTK P2P (`UDP :32100`).

**Status:** research complete, implementation in progress (`src/rtc/` probe).

## Root cause

| When | What |
|------|------|
| **2026-07-09 ~00:12** | Sec module **1.5.1.6** applied |
| **2026-07-10 ~00:06** | Firmware **4.2.3.3** applied |
| Same window | HA P2P (`All address lookup tentatives failed`), Alexa/Google bridges broke |

Legacy client sends TUTK lookup (`0xf16a`) to `:32100` masters → **`LOOKUP_RESP` error `0xFC`** (rejected).

Official app + [security.eufy.com](https://security.eufy.com/) use **WebRTC + TURN** instead.

## Target architecture

```
MegaHTTPApi (auth token, gtoken)
        │
        ▼
① WSS  security-smart.eufylife.com/v1/rtc/ws/join?reqtype=nvr
        │  envelope: { msgid, data: "<inner JSON string>" }
        │  inner: { action, dataType, sn, sessionId, source, ... }
        ▼
② WebRTC (offer/answer via signaling — SDP includes sctp datachannel)
        │  ICE: turn:13.248.157.102:3478  (realm anker.com, coturn)
        │  relay: 52.201.202.155:<port>
        ▼
③ SCTP data channels (DTLS)
        WebrtcDataChannel  ← device commands (PTZ, lights, guard mode)
        notify, video, audio, idr, download
```

## Captured constants (2026-07-11)

| Item | Value |
|------|--------|
| Signaling WS | `wss://security-smart.eufylife.com/v1/rtc/ws/join?reqtype=nvr` |
| TURN | `turn:13.248.157.102:3478` |
| Relay peer (example) | `52.201.202.155:58548` |
| Station SN | `T9000P1025350E47` |
| WS `dataType` (session) | `scall`, `info` |
| WS `action` (session) | `3` |
| Command channel label | `WebrtcDataChannel` |
| Legacy P2P | **dead** (`0xFC` on `:32100`) |

## WebSocket message envelope

Outer (wire):

```json
{
  "msgid": "<hex uuid>",
  "data": "<stringified inner JSON, escaped>"
}
```

Inner (example session call):

```json
{
  "code": 200,
  "action": 3,
  "sessionId": "<base64>",
  "sn": "T9000P1025350E47",
  "channelId": 0,
  "dataType": "scall",
  "source": "WEB",
  "ts": 1783808070,
  "data": "{\"timestamp\":...,\"account\":\"...\"}"
}
```

Binary WS frames may wrap the same JSON string.

## Auth (web portal — reverse-engineered 2026-07-11)

1. **GET** `https://security-smart.eufylife.com/v1/smart/nvr/ws/sign`  
   Headers: `X-Auth-Token`, `GToken`, `App-Name: eufy_mega`, `Model-Type: WEB`  
   Returns: `sign` blob used in steps 2–3.

2. **WebSocket** `wss://security-smart.eufylife.com/v1/rtc/ws/join?reqtype=nvr`  
   **Subprotocols:** `["v1", <base64url(JSON)>]` where JSON is:
   ```json
   {
     "region": "US",
     "type": "NVR",
     "sn": "T9000P1025350E47",
     "token": "<mega auth token>",
     "gtoken": "<md5(user_id)>",
     "sign": "<from step 1>",
     "appName": "eufy_mega",
     "modelType": "WEB"
   }
   ```
   (`base64url` = base64 with `+` → `-`, `/` → `_`, strip `=`)

3. **On open — sendAuth:**
   ```json
   { "msgid": "0", "data": "{\"code\":200,\"action\":1,\"data\":<sign>,\"sn\":\"...\",\"source\":\"WEB\",\"ts\":...}" }
   ```

4. **Session call — sendCall / scall** (`action`: 3, `dataType`: `scall`) then WebRTC offer/answer.

HTTP headers on the WS upgrade alone are **not** sufficient (probe confirmed).

## Implementation phases

### Phase 1 — Signaling WS (current)

- [ ] Connect `join?reqtype=nvr` with mega session headers
- [ ] Parse `{ msgid, data }` envelopes
- [ ] Receive `scall` / `info` for station SN
- [ ] Log SDP / ICE hints if sent over WS

### Phase 2 — WebRTC peer

- [ ] Fetch TURN credentials (API TBD — may arrive in WS or REST)
- [ ] Build `RTCPeerConnection` (Node: `werift` / `@roamhq/wrtc` or similar)
- [ ] Open `WebrtcDataChannel` + `notify`

### Phase 3 — Command codec

- [ ] Map legacy P2P `command_id` / `cmd` (e.g. 1350 / 9276 PTZ) to data-channel payloads
- [ ] Floodlight / guard mode commands
- [ ] Integrate into `Station` class; bypass legacy `P2PClientProtocol` for T9000

### Phase 4 — HA add-on

- [ ] Bump `EUFY_CLIENT_BUILD_ID`, rebuild customrepo add-on
- [ ] Re-enable automations once `binary_sensor.homebase_s1_connected` is reliable

## Ruled out

- Legacy P2P `:32100` / local `:32108`
- HomeKit / Matter on S1
- Google Home / Alexa bridges (devices unresponsive after firmware)
- Local `:18060` web UI from LAN (empty without HDMI session)
- Local `:18550` `/v1/hub/*` (403 without GUI auth)
- `:50100` command WS (localhost only on device)

## References

- Client fork: `genomez/eufy-security-client#T9000-testing`
- Upstream T9000 P2P issue: [bropat/eufy-security-client#764](https://github.com/bropat/eufy-security-client/issues/764)
- HA setup (pre-WebRTC): [T9000-SETUP.md](./T9000-SETUP.md)
