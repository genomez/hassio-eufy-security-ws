#!/usr/bin/with-contenv bashio

CONFIG_PATH=/data/eufy-security-ws-config.json
OPTIONS_PATH=/data/options.json
TEST_STARTUP_PHASE=entry

test_startup_exit() {
    local status=$?
    if [ "$status" -ne 0 ]; then
        bashio::log.error "TEST_STARTUP exit phase=${TEST_STARTUP_PHASE} code=${status}" || true
    fi
}
trap test_startup_exit EXIT

# Reporter-only test guard: prove which compiled server/client files the add-on will execute.
# This runs before configuration values are read and never logs credentials or session data.
WS_ROOT=/usr/src/app/node_modules/eufy-security-ws
WS_ENTRY="$WS_ROOT/dist/bin/server.js"
WS_SERVER="$WS_ROOT/dist/lib/server.js"
WS_MEGA_LOGIN="$WS_ROOT/dist/lib/driver/mega_login.js"
PROVENANCE_FAILED=0

check_provenance_marker() {
    local label="$1"
    local file="$2"
    local marker="$3"
    if [ ! -f "$file" ]; then
        bashio::log.error "TEST_PROVENANCE missing_file label=${label} path=${file}"
        PROVENANCE_FAILED=1
        return
    fi
    if ! grep -Fq "$marker" "$file"; then
        bashio::log.error "TEST_PROVENANCE missing_marker label=${label} path=${file}"
        PROVENANCE_FAILED=1
        return
    fi
    bashio::log.info "TEST_PROVENANCE marker_ok label=${label} path=${file} sha256=$(sha256sum "$file" | awk '{print $1}')"
}

if [ ! -f "$WS_ENTRY" ]; then
    bashio::log.error "TEST_PROVENANCE missing_file label=ws_entry path=${WS_ENTRY}"
    exit 1
fi

CLIENT_ENTRY="$(
    /usr/bin/node --input-type=module - "$WS_ENTRY" <<'NODE'
import { createRequire } from "node:module";
const requireFromWs = createRequire(process.argv[2]);
process.stdout.write(requireFromWs.resolve("eufy-security-client"));
NODE
)"
CLIENT_ROOT="${CLIENT_ENTRY%%/build/*}"
CLIENT_RTC_SIGNALING="$CLIENT_ROOT/build/rtc/rtcSignaling.js"
CLIENT_MEGA_API="$CLIENT_ROOT/build/http/megaApi.js"

bashio::log.info "TEST_PROVENANCE build=${EUFY_TEST_BUILD_ID:-unknown} ws_version=$(jq -r .version "$WS_ROOT/package.json") client_version=$(jq -r .version "$CLIENT_ROOT/package.json")"
bashio::log.info "TEST_PROVENANCE resolved ws_entry=${WS_ENTRY} client_entry=${CLIENT_ENTRY}"
check_provenance_marker "ws_post_connect_fallback" "$WS_SERVER" "post-connect-fallback"
check_provenance_marker "ws_mega_bootstrap" "$WS_MEGA_LOGIN" "v6 mega login: bootstrap triggered"
check_provenance_marker "client_rtc_context" "$CLIENT_RTC_SIGNALING" "RtcSignaling fetchSign context"
check_provenance_marker "client_rtc_eu_host" "$CLIENT_RTC_SIGNALING" "security-smart-eu.eufylife.com"
check_provenance_marker "client_mega_lifecycle_queued" "$CLIENT_MEGA_API" "MegaApi lifecycle queued"
check_provenance_marker "client_mega_lifecycle_started" "$CLIENT_MEGA_API" "MegaApi lifecycle HTTP started"
check_provenance_marker "client_mega_lifecycle_timeout" "$CLIENT_MEGA_API" "MEGA_REQUEST_LIFECYCLE_TIMEOUT"
check_provenance_marker "client_mega_instance" "$CLIENT_MEGA_API" "MegaApi diagnostic instance initialized"
check_provenance_marker "client_mega_watchdog" "$CLIENT_MEGA_API" "MegaApi lifecycle watchdog armed"
check_provenance_marker "client_mega_dispatched" "$CLIENT_MEGA_API" "MegaApi lifecycle dispatched"
check_provenance_marker "client_mega_key_begin" "$CLIENT_MEGA_API" "MegaApi key/exchange begin"
check_provenance_marker "client_mega_session_gate" "$CLIENT_ROOT/build/eufysecurity.js" "v6 cloud wake: session gate"

if [ "$PROVENANCE_FAILED" -ne 0 ]; then
    bashio::log.error "TEST_PROVENANCE failed; refusing to start an incomplete test image"
    exit 1
fi
bashio::log.info "TEST_PROVENANCE complete status=ok"

TEST_STARTUP_PHASE=options_file_preflight
if [ ! -r "$OPTIONS_PATH" ]; then
    bashio::log.error "TEST_STARTUP options_file readable=false"
    exit 1
fi
if ! OPTIONS_PRESENCE="$(
    jq -r '[
      (.username? | type == "string" and length > 0),
      (.password? | type == "string" and length > 0),
      (.country? | type == "string" and length > 0),
      ((.country? // "") | ascii_upcase == "FR")
    ] | @tsv' "$OPTIONS_PATH"
)"; then
    bashio::log.error "TEST_STARTUP options_file readable=true valid_json=false"
    exit 1
fi
IFS=$'\t' read -r OPTIONS_USERNAME_PRESENT OPTIONS_PASSWORD_PRESENT OPTIONS_COUNTRY_PRESENT OPTIONS_COUNTRY_IS_FR <<< "$OPTIONS_PRESENCE"
bashio::log.info "TEST_STARTUP options_file readable=true valid_json=true username_present=${OPTIONS_USERNAME_PRESENT} password_present=${OPTIONS_PASSWORD_PRESENT} country_present=${OPTIONS_COUNTRY_PRESENT} country_is_fr=${OPTIONS_COUNTRY_IS_FR}"

USERNAME=""
PASSWORD=""
COUNTRY=""
EVENT_DURATION_SECONDS=""
POLLING_INTERVAL_MINUTES=""
ACCEPT_INVITATIONS=""
TRUSTED_DEVICE_NAME=""
STATIONS_CONFIG=""
PORT_VALUE=""
DEBUG_VALUE=""
IPV4FIRST_VALUE=""

read_config_option() {
    local destination="$1"
    local key="$2"
    local value=""
    local present=false

    TEST_STARTUP_PHASE="config_read_${key}"
    bashio::log.info "TEST_STARTUP config_read_start label=${key}"
    if ! value="$(bashio::config "$key")"; then
        bashio::log.error "TEST_STARTUP config_read_failed label=${key}"
        return 1
    fi
    if [ -n "$value" ] && [ "$value" != "null" ]; then
        present=true
    fi
    printf -v "$destination" '%s' "$value"
    bashio::log.info "TEST_STARTUP config_read_ok label=${key} present=${present}"
}

read_config_option USERNAME username
read_config_option PASSWORD password
read_config_option COUNTRY country
read_config_option EVENT_DURATION_SECONDS event_duration
read_config_option POLLING_INTERVAL_MINUTES polling_interval
read_config_option ACCEPT_INVITATIONS accept_invitations
read_config_option TRUSTED_DEVICE_NAME trusted_device_name
read_config_option STATIONS_CONFIG stations
read_config_option PORT_VALUE port
read_config_option DEBUG_VALUE debug
read_config_option IPV4FIRST_VALUE ipv4first
TEST_STARTUP_PHASE=config_reads_complete
bashio::log.info "TEST_STARTUP config_reads_complete status=ok"

COUNTRY_JQ=""
if [ -n "$COUNTRY" ] && [ "$COUNTRY" != "null" ]; then
    COUNTRY_JQ="country: \$country,"
fi

EVENT_DURATION_SECONDS_JQ=""
if [ -n "$EVENT_DURATION_SECONDS" ] && [ "$EVENT_DURATION_SECONDS" != "null" ]; then
    EVENT_DURATION_SECONDS_JQ="eventDurationSeconds: \$event_duration_seconds|tonumber,"
fi

POLLING_INTERVAL_MINUTES_JQ=""
if [ -n "$POLLING_INTERVAL_MINUTES" ] && [ "$POLLING_INTERVAL_MINUTES" != "null" ]; then
    POLLING_INTERVAL_MINUTES_JQ="pollingIntervalMinutes: \$polling_interval_minutes|tonumber,"
fi

ACCEPT_INVITATIONS_JQ=""
if [ "$ACCEPT_INVITATIONS" = "true" ]; then
    ACCEPT_INVITATIONS_JQ="acceptInvitations: \$accept_invitations,"
fi

TRUSTED_DEVICE_NAME_JQ=""
if [ -n "$TRUSTED_DEVICE_NAME" ] && [ "$TRUSTED_DEVICE_NAME" != "null" ]; then
    TRUSTED_DEVICE_NAME_JQ="trustedDeviceName: \$trusted_device_name,"
fi

STATION_IP_ADDRESSES_ARG=""
STATION_IP_ADDRESSES_JQ=""
if [ -n "$STATIONS_CONFIG" ] && [ "$STATIONS_CONFIG" != "null" ]; then
    while read -r data
    do
        TMP_DATA=($(echo "${data}" | tr -d "{}\"[:blank:]" | tr "," " " | sed 's/serial_number://g;s/ip_address://g'))
        if [ "$STATION_IP_ADDRESSES_ARG" = "" ]; then
            STATION_IP_ADDRESSES_ARG="--arg ${TMP_DATA[0]} ${TMP_DATA[1]}"
            STATION_IP_ADDRESSES_JQ="stationIPAddresses: { \$${TMP_DATA[0]}"
        else
            STATION_IP_ADDRESSES_ARG="$STATION_IP_ADDRESSES_ARG --arg ${TMP_DATA[0]} ${TMP_DATA[1]}"
            STATION_IP_ADDRESSES_JQ="$STATION_IP_ADDRESSES_JQ, \$${TMP_DATA[0]}"
        fi
    done <<<"$STATIONS_CONFIG"
    if [ "$STATION_IP_ADDRESSES_ARG" != "" ]; then
        STATION_IP_ADDRESSES_JQ="$STATION_IP_ADDRESSES_JQ }"
    fi
    #bashio::log.info "STATION_IP_ADDRESSES_JQ: ${STATION_IP_ADDRESSES_JQ}"
    #bashio::log.info "STATION_IP_ADDRESSES_ARG: ${STATION_IP_ADDRESSES_ARG}"
fi

PORT_OPTION=""
if [ -n "$PORT_VALUE" ] && [ "$PORT_VALUE" != "null" ]; then
    PORT_OPTION="--port $PORT_VALUE"
fi

DEBUG_OPTION=""
if [ "$DEBUG_VALUE" = "true" ]; then
    DEBUG_OPTION="-v"
fi

IPV4_FIRST_NODE_OPTION=""
if [ "$IPV4FIRST_VALUE" = "true" ]; then
    IPV4_FIRST_NODE_OPTION="--dns-result-order=ipv4first"
fi

# T9000 WebRTC: bind ICE host candidates to the LAN interface that reaches the hub.
TEST_STARTUP_PHASE=rtc_bind_discovery
FIRST_STATION_IP=""
if [ -n "$STATIONS_CONFIG" ] && [ "$STATIONS_CONFIG" != "null" ]; then
    while read -r data; do
        if [ -n "$data" ]; then
            TMP_RTC=($(echo "${data}" | tr -d "{}\"[:blank:]" | tr "," " " | sed 's/serial_number://g;s/ip_address://g'))
            if [ -n "${TMP_RTC[1]}" ]; then
                FIRST_STATION_IP="${TMP_RTC[1]}"
                break
            fi
        fi
    done <<<"$STATIONS_CONFIG"
fi
if [ -n "$FIRST_STATION_IP" ]; then
    if ! RTC_BIND_ADDRESS="$(ip -4 route get "$FIRST_STATION_IP" 2>/dev/null | awk '/src/ { for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }')"; then
        RTC_BIND_ADDRESS=""
    fi
    if [ -n "$RTC_BIND_ADDRESS" ]; then
        export RTC_BIND_ADDRESS
        bashio::log.info "RTC_BIND_ADDRESS=${RTC_BIND_ADDRESS} (route to ${FIRST_STATION_IP})"
    fi
fi
if [ -z "${RTC_BIND_ADDRESS:-}" ]; then
    if ! RTC_BIND_ADDRESS="$(hostname -I 2>/dev/null | awk '{print $1}')"; then
        RTC_BIND_ADDRESS=""
    fi
    if [ -n "$RTC_BIND_ADDRESS" ]; then
        export RTC_BIND_ADDRESS
        bashio::log.info "RTC_BIND_ADDRESS=${RTC_BIND_ADDRESS} (hostname -I)"
    fi
fi
bashio::log.info "TEST_STARTUP rtc_bind_discovery status=ok address_present=$([ -n "${RTC_BIND_ADDRESS:-}" ] && echo true || echo false)"

# RTC_VERBOSE dumps raw signaling frames + libdatachannel debug (very high volume). Keep off for
# normal operation, set to 1 only when debugging RTC. NOTE: the T9000 DTLS handshake is timing
# sensitive — it used to complete only when verbose logging happened to pace the native threads.
# RTC_HANDSHAKE_PACE_MS now reproduces that pacing deterministically (see rtcPeer.ts), so the
# handshake is reliable with verbose OFF.
export RTC_VERBOSE="${RTC_VERBOSE:-0}"
# Probe: hub SDP fingerprint is sha-256 but libdatachannel remoteFingerprint() often returns empty sha-1.
export RTC_SKIP_FP_VERIFY="${RTC_SKIP_FP_VERIFY:-1}"
# Per-message block (ms) applied inside the libdatachannel Debug log callback, but ONLY while a
# peer is mid-handshake (never during steady-state streaming). This paces the native ICE/DTLS
# threads just enough for the T9000 DTLS handshake to complete. Set to 0 to disable pacing.
export RTC_HANDSHAKE_PACE_MS="${RTC_HANDSHAKE_PACE_MS:-0.6}"
# A failed RTC connect attempt (e.g. a DTLS handshake that loses its timing race under startup
# load) should retry quickly instead of blocking for the old 3-minute default.
export RTC_CONNECT_TIMEOUT_MS="${RTC_CONNECT_TIMEOUT_MS:-45000}"
# T9000 firmware (2026-07) expects the CLIENT to send the SDP offer after scall 100+TURN.
# Hub-as-offerer (0) is currently required: client-offer mode reaches ICE but hub never
# answers DTLS (ClientHello blackholed). Answerer mode completes WebrtcDataChannel ~300ms.
export RTC_CLIENT_OFFER="${RTC_CLIENT_OFFER:-0}"
# If >0 and CLIENT_OFFER=0: send our SDP offer after this many ms waiting for hub offer.
# Keep 0 for now — client-offer DTLS is unreliable on current T9000 firmware.
export RTC_HUB_OFFER_WAIT_MS="${RTC_HUB_OFFER_WAIT_MS:-0}"
# Send an explicit DTLS role in our offer (the hub can't negotiate from "actpass"): we are
# active (DTLS client), so the hub must be passive (server). Answer role is coerced to match.
export RTC_SIGNAL_SETUP="${RTC_SIGNAL_SETUP:-active}"
export RTC_ANSWER_SETUP="${RTC_ANSWER_SETUP:-passive}"
# LAN host pair is the only ICE path that connects (relay-only never completes checks).
export RTC_ICE_POLICY="${RTC_ICE_POLICY:-all}"
# Skip the Eufy TURN relay entirely (host-only ICE). The relay answers STUN checks so ICE could
# nominate it, but DTLS never completes over the T9000 relay path — if that pair won the race the
# handshake stalled ~31s and dropped. With NO_TURN we neither gather a local relay nor accept the
# hub's remote relay candidate, leaving only the direct LAN host pair that actually carries DTLS.
export RTC_NO_TURN="${RTC_NO_TURN:-1}"
export RTC_DELAY_SDP_UNTIL_GATHERING="${RTC_DELAY_SDP_UNTIL_GATHERING:-0}"
export RTC_POLL_MAX_MISSES="${RTC_POLL_MAX_MISSES:-3}"
export RTC_POLL_WATCHDOG_MS="${RTC_POLL_WATCHDOG_MS:-35000}"
# Periodic hub-first property sync. With proactive handoff ~270s, 5m was redundant; 15m is enough.
export RTC_PROPERTY_REFRESH_MS="${RTC_PROPERTY_REFRESH_MS:-900000}"
# Hub soft-TTL ~360s: SCTP/command app-data stops (ICE may live). Bare sometimes soft-recovers
# after ~15s; HA / some bare rides hard-cliff. Do not rely on same-session hold — refresh early.
# With RTC_HANDOFF=1 (default) open a second session before closing the first (~25s gap avoided).
# 0 = disabled.
export RTC_PROACTIVE_RECONNECT_MS="${RTC_PROACTIVE_RECONNECT_MS:-270000}"
# Make-before-break WebRTC refresh. 0 = old hard-close proactive reconnect.
export RTC_HANDOFF="${RTC_HANDOFF:-1}"
# libsctp PTCS padding: 1000 → ~1085B UDP (worse cliff behavior); 800 → ~885B (production default).
# Still pair with proactive+handoff — SCTP800 alone does not guarantee HA hold past ~360s.
export RTC_SCTP_MAX_PACKET_BYTES="${RTC_SCTP_MAX_PACKET_BYTES:-800}"
# After inventory cloud-wake: swipe-refresh wake (hub scall + TURN Allocate). Capture showed
# phone pull-to-refresh hits Coturn :3478 without opening a camera.
export RTC_SWIPE_WAKE="${RTC_SWIPE_WAKE:-1}"
export RTC_SWIPE_WAKE_AFTER_FAILURES="${RTC_SWIPE_WAKE_AFTER_FAILURES:-3}"
export RTC_SWIPE_WAKE_MIN_INTERVAL_MS="${RTC_SWIPE_WAKE_MIN_INTERVAL_MS:-90000}"
export RTC_SWIPE_WAKE_TIMEOUT_MS="${RTC_SWIPE_WAKE_TIMEOUT_MS:-20000}"
export RTC_SWIPE_WAKE_CAMERA_TIMEOUT_MS="${RTC_SWIPE_WAKE_CAMERA_TIMEOUT_MS:-20000}"
# Rich TURN wake: harvest creds via scall (no peer) then Allocate/permission/burst.
export RTC_TURN_HARVEST_TIMEOUT_MS="${RTC_TURN_HARVEST_TIMEOUT_MS:-8000}"
export RTC_TURN_ALLOCATE_TIMEOUT_MS="${RTC_TURN_ALLOCATE_TIMEOUT_MS:-8000}"
export RTC_TURN_BURST_MS="${RTC_TURN_BURST_MS:-2500}"
# After TURN harvest: garage camera live-view with production ICE (default on).
export RTC_SWIPE_WAKE_CAMERA_FALLBACK="${RTC_SWIPE_WAKE_CAMERA_FALLBACK:-1}"
# Legacy aliases (RTC_LIVE_WAKE_* still honored as fallbacks in code).
export RTC_LIVE_WAKE="${RTC_LIVE_WAKE:-1}"
export RTC_LIVE_WAKE_AFTER_FAILURES="${RTC_LIVE_WAKE_AFTER_FAILURES:-3}"
export RTC_LIVE_WAKE_MIN_INTERVAL_MS="${RTC_LIVE_WAKE_MIN_INTERVAL_MS:-90000}"
export RTC_LIVE_WAKE_TIMEOUT_MS="${RTC_LIVE_WAKE_TIMEOUT_MS:-20000}"
# Optional camera SN for live-view wake fallback (empty = skip camera path unless set).
export RTC_LIVE_WAKE_DEVICE_SN="${RTC_LIVE_WAKE_DEVICE_SN:-}"
# Prefer longer camera wake hold so START_LIVESTREAM can clear DTLS wedges.
export RTC_SWIPE_WAKE_CAMERA_TIMEOUT_MS="${RTC_SWIPE_WAKE_CAMERA_TIMEOUT_MS:-20000}"
export RTC_FLOODLIGHT_NOTIFY_ON_GRACE_MS="${RTC_FLOODLIGHT_NOTIFY_ON_GRACE_MS:-45000}"
export RTC_FLOODLIGHT_POLL_INTERVAL_MIN="${RTC_FLOODLIGHT_POLL_INTERVAL_MIN:-2}"
bashio::log.info "RTC_ICE_POLICY=${RTC_ICE_POLICY} RTC_DELAY_SDP_UNTIL_GATHERING=${RTC_DELAY_SDP_UNTIL_GATHERING} RTC_POLL_MAX_MISSES=${RTC_POLL_MAX_MISSES} RTC_POLL_WATCHDOG_MS=${RTC_POLL_WATCHDOG_MS} RTC_PROPERTY_REFRESH_MS=${RTC_PROPERTY_REFRESH_MS} RTC_PROACTIVE_RECONNECT_MS=${RTC_PROACTIVE_RECONNECT_MS} RTC_HANDOFF=${RTC_HANDOFF} RTC_SCTP_MAX_PACKET_BYTES=${RTC_SCTP_MAX_PACKET_BYTES} RTC_SWIPE_WAKE=${RTC_SWIPE_WAKE} RTC_SWIPE_WAKE_AFTER_FAILURES=${RTC_SWIPE_WAKE_AFTER_FAILURES} RTC_SWIPE_WAKE_CAMERA_FALLBACK=${RTC_SWIPE_WAKE_CAMERA_FALLBACK} RTC_TURN_BURST_MS=${RTC_TURN_BURST_MS} RTC_FLOODLIGHT_POLL_INTERVAL_MIN=${RTC_FLOODLIGHT_POLL_INTERVAL_MIN}"

TEST_STARTUP_PHASE=json_build
bashio::log.info "TEST_STARTUP json_build_start"
if ! JSON_STRING="$( jq -n \
  --arg username "$USERNAME" \
  --arg password "$PASSWORD" \
  --arg country "$COUNTRY" \
  --arg event_duration_seconds "$EVENT_DURATION_SECONDS" \
  --arg polling_interval_minutes "$POLLING_INTERVAL_MINUTES" \
  --arg trusted_device_name "$TRUSTED_DEVICE_NAME" \
  --arg accept_invitations "$ACCEPT_INVITATIONS" \
  $STATION_IP_ADDRESSES_ARG \
    "{
      username: \$username,
      password: \$password,
      persistentDir: \"/data\",
      $COUNTRY_JQ
      $EVENT_DURATION_SECONDS_JQ
      $POLLING_INTERVAL_MINUTES_JQ
      $TRUSTED_DEVICE_NAME_JQ
      $ACCEPT_INVITATIONS_JQ
      $STATION_IP_ADDRESSES_JQ
    }"
  )"; then
    bashio::log.error "TEST_STARTUP json_build_failed"
    exit 1
fi
bashio::log.info "TEST_STARTUP json_build_complete status=ok"

check_version() {
    if [ "$1" = "$2" ]; then
        return 1 # equal
    fi
    version=$(printf '%s\n' "$1" "$2" | sort -V | tail -n 1)
    if [ "$version" = "$2" ]; then
        return 2 # greater
    fi
    return 0 # lower
}

TEST_STARTUP_PHASE=required_options_check
if [ -n "$USERNAME" ] && [ "$USERNAME" != "null" ] && [ -n "$PASSWORD" ] && [ "$PASSWORD" != "null" ]; then
    TEST_STARTUP_PHASE=config_file_write
    if ! printf '%s\n' "$JSON_STRING" > "$CONFIG_PATH"; then
        bashio::log.error "TEST_STARTUP config_file_write_failed"
        exit 1
    fi
    if ! jq -e 'type == "object" and (.username | type == "string" and length > 0) and (.password | type == "string" and length > 0)' "$CONFIG_PATH" >/dev/null; then
        bashio::log.error "TEST_STARTUP config_file_validation_failed"
        exit 1
    fi
    bashio::log.info "TEST_STARTUP config_file_ready status=ok"
    TEST_STARTUP_PHASE=node_exec
    bashio::log.info "TEST_STARTUP node_exec path=/usr/src/app/node_modules/eufy-security-ws/dist/bin/server.js"
    exec /usr/bin/node $IPV4_FIRST_NODE_OPTION /usr/src/app/node_modules/eufy-security-ws/dist/bin/server.js --host 0.0.0.0 --config $CONFIG_PATH $DEBUG_OPTION $PORT_OPTION
else
    bashio::log.error "TEST_STARTUP required_options_missing username_present=${OPTIONS_USERNAME_PRESENT} password_present=${OPTIONS_PASSWORD_PRESENT}"
    exit 1
fi

