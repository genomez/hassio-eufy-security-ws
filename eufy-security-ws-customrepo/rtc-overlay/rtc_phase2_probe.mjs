#!/usr/bin/env node
/**
 * Phase 2 probe: sign → WS auth → scall → WebRTC → WebrtcDataChannel open.
 * Set RTC_VERBOSE=1 for DTLS/ICE/SCTP snapshot logs on stdout.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const require = createRequire(import.meta.url);
const PERSIST = process.env.PERSIST_PATH || "/data/persistent.json";
const STATION_SN = process.env.STATION_SN || "T9000P1025350E47";
const CHANNEL_ID = Number(process.env.CHANNEL_ID || "0");
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || "90000");
const VERBOSE = process.env.RTC_VERBOSE === "1" || process.env.RTC_VERBOSE === "true";

function loadSession() {
  const raw = JSON.parse(readFileSync(PERSIST, "utf8"));
  const mega = raw.megaApi || {};
  const token = mega.cloud_token || raw.cloud_token;
  const userId = mega.user_id || raw.httpApi?.user_id;
  const adminUserId =
    raw.admin_user_id ||
    mega.admin_user_id ||
    raw.httpApi?.admin_user_id ||
    userId;
  const ab = (mega.ab || raw.country || "us").toUpperCase();
  if (!token || !userId) throw new Error("missing token or user_id");
  return {
    token,
    userId,
    adminUserId,
    gtoken: createHash("md5").update(userId).digest("hex"),
    region: ab,
  };
}

function resolveClientRoot() {
  const candidates = [
    "/usr/src/app/node_modules/eufy-security-client",
    "/usr/src/app/node_modules/eufy-security-ws/node_modules/eufy-security-client",
  ];
  for (const p of candidates) {
    try {
      require.resolve(join(p, "build/rtc/rtcSession.js"));
      return p;
    } catch {
      /* try next */
    }
  }
  throw new Error("eufy-security-client with rtc build not found");
}

async function enableVerboseLogging(clientRoot) {
  if (!VERBOSE) return;
  const logging = await import(join(clientRoot, "build/logging.js"));
  const logger = logging.rootHTTPLogger;
  for (const level of ["info", "warn", "debug"]) {
    const orig = logger[level]?.bind(logger);
    if (!orig) continue;
    logger[level] = (msg, ctx) => {
      const text = String(msg);
      if (
        text.includes("RtcPeer") ||
        text.includes("RtcSession") ||
        text.includes("RtcSignaling")
      ) {
        console.log(`[${level}]`, text, ctx ? JSON.stringify(ctx) : "");
      }
      return orig(msg, ctx);
    };
  }
  console.log("RTC_VERBOSE enabled — logging RtcPeer/RtcSession/RtcSignaling to stdout");
}

async function main() {
  const clientRoot = resolveClientRoot();
  await enableVerboseLogging(clientRoot);
  const { RtcSession } = await import(join(clientRoot, "build/rtc/rtcSession.js"));

  const { token, gtoken, region, adminUserId } = loadSession();
  console.log("phase2 probe", {
    station: STATION_SN,
    region,
    channel: CHANNEL_ID,
    clientRoot,
    verbose: VERBOSE,
    adminUserId: adminUserId?.slice(0, 8) + "...",
  });

  const session = new RtcSession({
    authToken: token,
    gtoken,
    stationSn: STATION_SN,
    region,
    adminUserId,
    channelId: CHANNEL_ID,
  });

  let turnSeen = false;
  session.on("turn", (turn) => {
    turnSeen = true;
    console.log("TURN", turn.turn_addr, turn.turn_port, turn.turn_user?.slice(0, 12) + "...");
  });
  session.on("connected", () => {
    console.log("SUCCESS: WebrtcDataChannel open");
    clearTimeout(timer);
    setTimeout(() => {
      session.close();
      process.exit(0);
    }, 2000);
  });
  session.on("error", (err) => {
    console.error("ERROR", err.message);
  });
  session.on("close", () => {
    console.log("session closed");
  });

  const timer = setTimeout(() => {
    console.log("TIMEOUT", { turnSeen, verbose: VERBOSE });
    session.close();
    process.exit(turnSeen ? 3 : 2);
  }, TIMEOUT_MS);

  try {
    await session.connect();
  } catch (err) {
    console.error("connect failed", err.message);
    clearTimeout(timer);
    process.exit(1);
  }
}

main();
