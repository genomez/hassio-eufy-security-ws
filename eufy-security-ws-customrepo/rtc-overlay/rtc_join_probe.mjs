#!/usr/bin/env node
/**
 * Probe T9000 RTC signaling: GET /smart/nvr/ws/sign → WS subprotocol auth → sendAuth.
 */
import { createHash, randomUUID } from "crypto";
import { readFileSync } from "fs";

const PERSIST = process.env.PERSIST_PATH || "/data/persistent.json";
const STATION_SN = process.env.STATION_SN || "T9000P1025350E47";
const SMART_HOST = process.env.SMART_HOST || "security-smart.eufylife.com";
const WS_URL = `wss://${SMART_HOST}/v1/rtc/ws/join?reqtype=nvr`;
const SIGN_URL = `https://${SMART_HOST}/v1/smart/nvr/ws/sign`;

function base64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function loadSession() {
  const raw = JSON.parse(readFileSync(PERSIST, "utf8"));
  const mega = raw.megaApi || {};
  const token = mega.cloud_token || raw.cloud_token;
  const userId = mega.user_id || raw.httpApi?.user_id;
  const ab = (mega.ab || raw.country || "us").toUpperCase();
  if (!token || !userId) throw new Error("missing token or user_id");
  return { token, userId, gtoken: createHash("md5").update(userId).digest("hex"), region: ab };
}

async function fetchSign(token, gtoken) {
  const res = await fetch(SIGN_URL, {
    headers: {
      "X-Auth-Token": token,
      GToken: gtoken,
      "App-Name": "eufy_mega",
      "Model-Type": "WEB",
      Country: "US",
      Language: "en",
      Origin: "https://security.eufy.com",
    },
  });
  const text = await res.text();
  console.log("sign HTTP", res.status, text.slice(0, 200));
  if (!res.ok) throw new Error(`sign failed ${res.status}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { data: text };
  }
  return body.data ?? body.sign ?? body;
}

const { token, userId, gtoken, region } = loadSession();
console.log("station", STATION_SN, "region", region);

const sign = await fetchSign(token, gtoken);
console.log("sign ok, type", typeof sign, String(sign).slice(0, 80));

const subprotoPayload = {
  region,
  type: "NVR",
  sn: STATION_SN,
  token,
  gtoken,
  sign,
  appName: "eufy_mega",
  modelType: "WEB",
};
const subproto = base64urlJson(subprotoPayload);
console.log("connecting", WS_URL, "subproto len", subproto.length);

const ws = new WebSocket(WS_URL, ["v1", subproto]);

const timeout = setTimeout(() => {
  console.log("timeout");
  ws.close();
  process.exit(0);
}, 25000);

ws.addEventListener("open", () => {
  console.log("WS open — sendAuth");
  const inner = {
    code: 200,
    action: 1,
    data: sign,
    sn: STATION_SN,
    source: "WEB",
    ts: Math.floor(Date.now() / 1000),
  };
  ws.send(JSON.stringify({ msgid: "0", data: JSON.stringify(inner) }));
});

ws.addEventListener("message", async (ev) => {
  let text;
  if (typeof ev.data === "string") text = ev.data;
  else if (ev.data instanceof Blob) text = await ev.data.text();
  else text = Buffer.from(ev.data).toString("utf8");
  console.log("recv", text.slice(0, 500));
  try {
    const outer = JSON.parse(text);
    if (outer.data) {
      const inner = JSON.parse(outer.data);
      console.log("  inner dataType=", inner.dataType, "action=", inner.action);
    }
  } catch {
    /* ignore */
  }
});

ws.addEventListener("close", (ev) => {
  clearTimeout(timeout);
  console.log("WS close", ev.code, ev.reason || "");
  process.exit(ev.code === 1000 ? 0 : 2);
});

ws.addEventListener("error", (ev) => {
  clearTimeout(timeout);
  console.error("WS error", ev.error?.message || ev);
  process.exit(1);
});
