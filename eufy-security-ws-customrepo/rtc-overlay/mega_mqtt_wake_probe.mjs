#!/usr/bin/env node
/**
 * Phase B live probe: AWS IoT mTLS connect using get_user_mqtt_info, subscribe
 * to T9000 topics, optionally publish a lightweight cmd ping.
 *
 * Run inside the eufy addon container:
 *   STATION_SN=T9000Pxxxxxxxxxxxx node /tmp/mega_mqtt_wake_probe.mjs
 */
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { join } from "path";

const require = createRequire(import.meta.url);
const PERSIST = process.env.PERSIST_PATH || "/data/persistent.json";
const STATION_SN = process.env.STATION_SN || "";
if (!STATION_SN) {
  console.error("Set STATION_SN to your HomeBase serial (e.g. T9000Pxxxxxxxxxxxx)");
  process.exit(1);
}
const PRODUCT = process.env.PRODUCT_PN || STATION_SN.slice(0, 5); // T9000
const HOLD_MS = Number(process.env.HOLD_MS || "90000");
const PUBLISH = process.env.MQTT_PUBLISH !== "0";

function fillTopic(tmpl, pn, sn) {
  return tmpl.replaceAll("PN", pn).replaceAll("SN", sn);
}

function writeTempPem(label, content) {
  const p = join(tmpdir(), `eufy-mega-mqtt-${label}-${process.pid}.pem`);
  writeFileSync(p, content, { mode: 0o600 });
  return p;
}

async function main() {
  const clientRoot = "/usr/src/app/node_modules/eufy-security-client";
  const mqttPath = require.resolve("mqtt", { paths: [clientRoot, "/usr/src/app"] });
  const mqtt = require(mqttPath);
  const { MegaHTTPApi } = await import(join(clientRoot, "build/http/megaApi.js"));

  const raw = JSON.parse(readFileSync(PERSIST, "utf8"));
  const megaSession = raw.megaApi;
  if (!megaSession?.cloud_token) throw new Error("no megaApi session in persistent.json");

  const mega = new MegaHTTPApi({
    ab: megaSession.ab || raw.country || "us",
    osType: "android",
    openudid: megaSession.openudid || raw.openudid,
  });
  await mega.init();
  mega.restoreSession(megaSession);
  if (!mega.hasValidSession()) throw new Error("mega session invalid/expired");

  // Stale ECDH identities from persistent.json often yield 4404 get identity error.
  // Clear them and refresh domains so key/exchange re-runs with the still-valid token.
  mega.restoreSession({ ...megaSession, identities: {} });
  try {
    await mega.estimateDomain();
  } catch (err) {
    console.warn("estimateDomain soft-fail", err?.message || err);
  }

  console.log("fetching getMqttConnectConfig…");
  let cfg;
  try {
    cfg = await mega.getMqttConnectConfig();
  } catch (err) {
    console.warn("first getMqttConnectConfig failed, clearing identities and retrying", err?.message || err);
    mega.restoreSession({ ...megaSession, identities: {} });
    await mega.estimateDomain();
    cfg = await mega.getMqttConnectConfig();
  }
  console.log("mqtt config", {
    endpoint: cfg.endpoint,
    port: cfg.port,
    clientId: cfg.clientId,
    thingName: cfg.thingName,
    userId: cfg.userId ? `${cfg.userId.slice(0, 6)}…` : undefined,
    hasCert: Boolean(cfg.certificatePem),
    hasKey: Boolean(cfg.privateKey),
    hasCa: Boolean(cfg.awsRootCaPem),
    topics: cfg.topics,
  });

  const certPath = writeTempPem("cert", cfg.certificatePem);
  const keyPath = writeTempPem("key", cfg.privateKey);
  const caPath = writeTempPem("ca", cfg.awsRootCaPem);

  const subCmd = fillTopic(cfg.topics.subCmd, PRODUCT, STATION_SN);
  const stateInfo = fillTopic(cfg.topics.stateInfo, PRODUCT, STATION_SN);
  const pubCmd = fillTopic(cfg.topics.pubCmd, PRODUCT, STATION_SN);
  const app = "eufy_mega";
  // App-name topics (Anker Solix pattern) + scaffolded eufy_security topics.
  const topics = [
    subCmd,
    stateInfo,
    pubCmd.replace("/req", "/res"),
    `cmd/${app}/${PRODUCT}/${STATION_SN}/res`,
    `cmd/${app}/${PRODUCT}/${STATION_SN}/param_info`,
    `cmd/${app}/${PRODUCT}/${STATION_SN}/#`,
    `synq/${app}/${PRODUCT}/${STATION_SN}/state_info`,
    `synq/${app}/${PRODUCT}/${STATION_SN}/#`,
    `cmd/eufy_security/${PRODUCT}/${STATION_SN}/res`,
    `synq/eufy_life/${PRODUCT}/${STATION_SN}/state_info`,
    // device-agnostic user inbox patterns seen in some Anker builds
    `cmd/${app}/+/+/res`,
    `phone/${cfg.userId}/notice`,
    `$aws/things/${cfg.thingName}/shadow/#`,
  ];

  // Discover product codes / mqtt flags from house inventory
  if (process.env.SKIP_DEVS !== "1") {
    try {
      const devs = await mega.getDevsListDecrypted();
      const arr = Array.isArray(devs) ? devs : devs?.devices || devs?.data || [];
      const slim = (Array.isArray(arr) ? arr : []).slice(0, 30).map((d) => ({
        sn: d.device_sn || d.station_sn || d.sn,
        pn: d.device_pn || d.product_code || d.pn,
        mqtt: d.is_support_mqtt,
        type: d.device_type,
      }));
      console.log("devs sample", JSON.stringify(slim, null, 2));
      for (const d of slim) {
        if (!d.sn || !d.pn) continue;
        topics.push(`cmd/${app}/${d.pn}/${d.sn}/res`);
        topics.push(`cmd/eufy_security/${d.pn}/${d.sn}/res`);
        topics.push(`synq/${app}/${d.pn}/${d.sn}/state_info`);
        topics.push(`synq/eufy_life/${d.pn}/${d.sn}/state_info`);
      }
    } catch (err) {
      console.warn("getDevsList soft-fail", err?.message || err);
    }
  }

  const clientIdMode = process.env.MQTT_CLIENT_ID_MODE || "android"; // android | thing
  const endpointMode = process.env.MQTT_ENDPOINT_MODE || "aiot"; // aiot | iotbing
  const clientId = clientIdMode === "thing" ? cfg.thingName : cfg.clientId;
  const endpoint =
    endpointMode === "iotbing"
      ? process.env.MQTT_ENDPOINT || "m1-us.iotbing.com"
      : cfg.endpoint;
  const port = Number(process.env.MQTT_PORT || cfg.port);

  const url = `mqtts://${endpoint}:${port}`;
  console.log("connecting", {
    url,
    clientId,
    clientIdMode,
    endpointMode,
    product: PRODUCT,
    station: STATION_SN,
  });

  const client = mqtt.connect(url, {
    protocol: "mqtts",
    port,
    host: endpoint,
    clientId,
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    ca: readFileSync(caPath),
    rejectUnauthorized: endpointMode === "aiot",
    keepalive: 30,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 20000,
  });

  const cleanup = () => {
    for (const p of [certPath, keyPath, caPath]) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  };

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 25000);
    client.on("connect", (ack) => {
      clearTimeout(t);
      console.log("CONNECTED", ack);
      resolve();
    });
    client.on("error", (err) => {
      clearTimeout(t);
      console.error("MQTT error", err?.message || err);
      reject(err);
    });
  });

  for (const topic of [...new Set(topics)]) {
    await new Promise((resolve) => {
      client.subscribe(topic, { qos: 1 }, (err, granted) => {
        if (err) console.warn("subscribe failed", topic, err.message);
        else {
          const g = granted?.[0];
          const qos = g?.qos;
          if (qos === 128 || qos === 0x80) console.warn("subscribe DENIED", topic, JSON.stringify(granted));
          else console.log("subscribed OK", topic, JSON.stringify(granted));
        }
        resolve();
      });
    });
  }

  if (PUBLISH) {
    const pubTopics = [
      pubCmd,
      `cmd/eufy_mega/${PRODUCT}/${STATION_SN}/req`,
      `cmd/eufy_mega/${PRODUCT}/${STATION_SN}/param_info`,
      `cmd/eufy_security/${PRODUCT}/${STATION_SN}/param_info`,
    ];
    const payloads = [
      Buffer.from("{}"),
      Buffer.from(JSON.stringify({ cmd: 0, timestamp: Date.now(), sn: STATION_SN })),
      Buffer.from(JSON.stringify({ action: "wake", sn: STATION_SN, ts: Math.floor(Date.now() / 1000) })),
    ];
    for (const topic of pubTopics) {
      for (const [i, payload] of payloads.entries()) {
        await new Promise((resolve) => {
          client.publish(topic, payload, { qos: 1 }, (err) => {
            if (err) console.warn(`publish[${i}] failed`, topic, err.message);
            else console.log(`publish[${i}] ok`, topic, "bytes=", payload.length);
            resolve();
          });
        });
      }
    }
  }

  client.on("message", (topic, message) => {
    const hex = message.toString("hex").slice(0, 120);
    const asText = (() => {
      try {
        return message.toString("utf8").slice(0, 200);
      } catch {
        return "";
      }
    })();
    console.log("MESSAGE", { topic, bytes: message.length, hex, text: asText });
  });

  console.log(`holding connection ${HOLD_MS}ms — watch HA sensors for recovery`);
  await new Promise((r) => setTimeout(r, HOLD_MS));
  client.end(true);
  cleanup();
  console.log("probe done");
}

main().catch((err) => {
  console.error("FATAL", err?.stack || err);
  process.exit(1);
});
