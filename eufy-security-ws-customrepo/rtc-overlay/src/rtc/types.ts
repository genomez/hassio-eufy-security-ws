/** Wire envelope on security-smart RTC WebSocket (web + app). */
export interface RtcWsEnvelope {
  msgid: string;
  data: string;
}

/** Parsed inner payload (data field JSON.parse). */
export interface RtcInnerMessage {
  code?: number;
  action?: number;
  sessionId?: string;
  sn?: string;
  subSn?: string;
  channelId?: number;
  isResponse?: number;
  dataType?: string;
  source?: string;
  ts?: number;
  data?: string;
  msgid?: string;
}

export interface RtcSignalingOptions {
  /** eufy_mega auth token */
  authToken: string;
  /** md5(user_id) hex — GToken header on web */
  gtoken: string;
  stationSn: string;
  /** admin_user_id for scall account field */
  adminUserId?: string;
  /** Default: security-smart.eufylife.com */
  smartHost?: string;
  /** WEB | APP — matches official clients */
  source?: string;
  /** Region code for sign/WS subprotocol, e.g. US */
  region?: string;
  connectTimeoutMs?: number;
  /** all | relay — default relay (matches official app TURN path). */
  iceTransportPolicy?: RTCIceTransportPolicy;
  /** DTLS setup in SDP answer — default passive. */
  dtlsSetup?: "active" | "passive";
  /** Override RTC_NO_TURN for this session (camera-channel live wake). */
  allowTurn?: boolean;
  /** NVR/camera channel for scall (0 = hub-level). */
  channelId?: number;
}

export const DEFAULT_RTC_WS_PATH = "/v1/rtc/ws/join?reqtype=nvr";
export const DEFAULT_SMART_HOST = "security-smart.eufylife.com";

/** eufy_mega session fields used for T9000 WebRTC signaling. */
export interface MegaRtcCredentials {
  authToken: string;
  userId: string;
  region: string;
}
