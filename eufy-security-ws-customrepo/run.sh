#!/usr/bin/with-contenv bashio

CONFIG_PATH=/data/eufy-security-ws-config.json

USERNAME="$(bashio::config 'username')"
PASSWORD="$(bashio::config 'password')"
COUNTRY="$(bashio::config 'country')"
EVENT_DURATION_SECONDS="$(bashio::config 'event_duration')"
POLLING_INTERVAL_MINUTES="$(bashio::config 'polling_interval')"
ACCEPT_INVITATIONS="$(bashio::config 'accept_invitations')"
TRUSTED_DEVICE_NAME="$(bashio::config 'trusted_device_name')"

COUNTRY_JQ=""
if bashio::config.has_value 'country'; then
    COUNTRY_JQ="country: \$country,"
fi

EVENT_DURATION_SECONDS_JQ=""
if bashio::config.has_value 'event_duration'; then
    EVENT_DURATION_SECONDS_JQ="eventDurationSeconds: \$event_duration_seconds|tonumber,"
fi

POLLING_INTERVAL_MINUTES_JQ=""
if bashio::config.has_value 'polling_interval'; then
    POLLING_INTERVAL_MINUTES_JQ="pollingIntervalMinutes: \$polling_interval_minutes|tonumber,"
fi

ACCEPT_INVITATIONS_JQ=""
if bashio::config.true 'accept_invitations'; then
    ACCEPT_INVITATIONS_JQ="acceptInvitations: \$accept_invitations,"
fi

TRUSTED_DEVICE_NAME_JQ=""
if bashio::config.has_value 'trusted_device_name'; then
    TRUSTED_DEVICE_NAME_JQ="trustedDeviceName: \$trusted_device_name,"
fi

STATION_IP_ADDRESSES_ARG=""
STATION_IP_ADDRESSES_JQ=""
if bashio::config.has_value 'stations'; then
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
    done <<<"$(bashio::config 'stations')"
    if [ "$STATION_IP_ADDRESSES_ARG" != "" ]; then
        STATION_IP_ADDRESSES_JQ="$STATION_IP_ADDRESSES_JQ }"
    fi
    #bashio::log.info "STATION_IP_ADDRESSES_JQ: ${STATION_IP_ADDRESSES_JQ}"
    #bashio::log.info "STATION_IP_ADDRESSES_ARG: ${STATION_IP_ADDRESSES_ARG}"
fi

PORT_OPTION=""
if bashio::config.has_value 'port'; then
    PORT_OPTION="--port $(bashio::config 'port')"
fi

DEBUG_OPTION=""
if bashio::config.true 'debug'; then
    DEBUG_OPTION="-v"
fi

IPV4_FIRST_NODE_OPTION=""
if bashio::config.true 'ipv4first'; then
    IPV4_FIRST_NODE_OPTION="--dns-result-order=ipv4first"
fi

# T9000 WebRTC: bind ICE host candidates to the LAN interface that reaches the hub.
FIRST_STATION_IP=""
if bashio::config.has_value 'stations'; then
    while read -r data; do
        if [ -n "$data" ]; then
            TMP_RTC=($(echo "${data}" | tr -d "{}\"[:blank:]" | tr "," " " | sed 's/serial_number://g;s/ip_address://g'))
            if [ -n "${TMP_RTC[1]}" ]; then
                FIRST_STATION_IP="${TMP_RTC[1]}"
                break
            fi
        fi
    done <<<"$(bashio::config 'stations')"
fi
if [ -n "$FIRST_STATION_IP" ]; then
    RTC_BIND_ADDRESS="$(ip -4 route get "$FIRST_STATION_IP" 2>/dev/null | awk '/src/ { for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }')"
    if [ -n "$RTC_BIND_ADDRESS" ]; then
        export RTC_BIND_ADDRESS
        bashio::log.info "RTC_BIND_ADDRESS=${RTC_BIND_ADDRESS} (route to ${FIRST_STATION_IP})"
    fi
fi
if [ -z "${RTC_BIND_ADDRESS:-}" ]; then
    RTC_BIND_ADDRESS="$(hostname -I 2>/dev/null | awk '{print $1}')"
    if [ -n "$RTC_BIND_ADDRESS" ]; then
        export RTC_BIND_ADDRESS
        bashio::log.info "RTC_BIND_ADDRESS=${RTC_BIND_ADDRESS} (hostname -I)"
    fi
fi

# RTC_VERBOSE dumps raw signaling frames + libdatachannel debug (very high volume). Keep off for
# normal operation, set to 1 only when debugging RTC. NOTE: the T9000 DTLS handshake is timing
# sensitive — it used to complete only when verbose logging happened to pace the native threads.
# RTC_HANDSHAKE_PACE_MS now reproduces that pacing deterministically (see rtcPeer.ts), so the
# handshake is reliable with verbose OFF.
export RTC_VERBOSE="${RTC_VERBOSE:-0}"
# Per-message block (ms) applied inside the libdatachannel Debug log callback, but ONLY while a
# peer is mid-handshake (never during steady-state streaming). This paces the native ICE/DTLS
# threads just enough for the T9000 DTLS handshake to complete. Set to 0 to disable pacing.
export RTC_HANDSHAKE_PACE_MS="${RTC_HANDSHAKE_PACE_MS:-0.6}"
# A failed RTC connect attempt (e.g. a DTLS handshake that loses its timing race under startup
# load) should retry quickly instead of blocking for the old 3-minute default.
export RTC_CONNECT_TIMEOUT_MS="${RTC_CONNECT_TIMEOUT_MS:-45000}"
# T9000 firmware (2026-07) expects the CLIENT to send the SDP offer after scall 100+TURN.
export RTC_CLIENT_OFFER="${RTC_CLIENT_OFFER:-1}"
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
export RTC_PROPERTY_REFRESH_MS="${RTC_PROPERTY_REFRESH_MS:-300000}"
bashio::log.info "RTC_ICE_POLICY=${RTC_ICE_POLICY} RTC_DELAY_SDP_UNTIL_GATHERING=${RTC_DELAY_SDP_UNTIL_GATHERING} RTC_POLL_MAX_MISSES=${RTC_POLL_MAX_MISSES} RTC_POLL_WATCHDOG_MS=${RTC_POLL_WATCHDOG_MS} RTC_PROPERTY_REFRESH_MS=${RTC_PROPERTY_REFRESH_MS}"

JSON_STRING="$( jq -n \
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
  )"

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

if bashio::config.has_value 'username' && bashio::config.has_value 'password'; then
    echo "$JSON_STRING" > $CONFIG_PATH
    exec /usr/bin/node $IPV4_FIRST_NODE_OPTION /usr/src/app/node_modules/eufy-security-ws/dist/bin/server.js --host 0.0.0.0 --config $CONFIG_PATH $DEBUG_OPTION $PORT_OPTION
else
    echo "Required parameters username and/or password not set. Starting aborted!"
fi

