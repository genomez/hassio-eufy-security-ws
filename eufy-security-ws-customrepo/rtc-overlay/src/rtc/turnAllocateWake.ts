/**
 * TURN wake matching phone swipe-refresh media traffic:
 * Allocate → CreatePermission → ChannelBind → Binding/ChannelData burst
 * toward the XOR-RELAYED-ADDRESS (Firewalla: ~242 UDP to relay host:port).
 */
import { createHash, createHmac, randomBytes } from "crypto";
import dgram from "dgram";

import { rootHTTPLogger } from "../logging";
import { RtcTurnConfig } from "./rtcPeer";

const STUN_MAGIC = 0x2112a442;
const ATTR_USERNAME = 0x0006;
const ATTR_MESSAGE_INTEGRITY = 0x0008;
const ATTR_ERROR_CODE = 0x0009;
const ATTR_CHANNEL_NUMBER = 0x000c;
const ATTR_LIFETIME = 0x000d;
const ATTR_XOR_PEER_ADDRESS = 0x0012;
const ATTR_DATA = 0x0013;
const ATTR_REALM = 0x0014;
const ATTR_NONCE = 0x0015;
const ATTR_XOR_RELAYED_ADDRESS = 0x0016;
const ATTR_REQUESTED_TRANSPORT = 0x0019;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;

const METHOD_BINDING = 0x0001;
const METHOD_ALLOCATE = 0x0003;
const METHOD_SEND = 0x0006;
const METHOD_CREATE_PERMISSION = 0x0008;
const METHOD_CHANNEL_BIND = 0x0009;

const CLASS_REQUEST = 0x0000;
const CLASS_INDICATION = 0x0010;
const CLASS_SUCCESS = 0x0100;
const CLASS_ERROR = 0x0110;

export interface TurnAllocateWakeOptions {
  /** Overall timeout including burst (default 8000). */
  timeoutMs?: number;
  /** How long to send Binding/ChannelData after setup (default 2500). */
  burstMs?: number;
  /** Peer IPs for CreatePermission (hub LAN IP, etc.). */
  peerIps?: string[];
}

export interface TurnAllocateWakeResult {
  ok: boolean;
  detail?: string;
  relayedHost?: string;
  relayedPort?: number;
  createPermissionOk?: boolean;
  channelBindOk?: boolean;
  burstPackets?: number;
}

interface TurnCreds {
  username: string;
  realm: string;
  nonce: string;
  password: string;
}

function stunType(method: number, cls: number): number {
  return (
    ((method & 0x0f80) << 2) |
    ((method & 0x0070) << 1) |
    (method & 0x000f) |
    ((cls & 0x0200) << 2) |
    ((cls & 0x0100) << 1)
  );
}

function decodeMethod(type: number): number {
  return ((type & 0x3e00) >> 2) | ((type & 0x00e0) >> 1) | (type & 0x000f);
}

function decodeClass(type: number): number {
  return type & 0x0110;
}

function tlv(type: number, value: Buffer): Buffer {
  const pad = (4 - (value.length % 4)) % 4;
  const buf = Buffer.alloc(4 + value.length + pad);
  buf.writeUInt16BE(type, 0);
  buf.writeUInt16BE(value.length, 2);
  value.copy(buf, 4);
  return buf;
}

function parseAttrs(msg: Buffer): Map<number, Buffer> {
  const map = new Map<number, Buffer>();
  let off = 20;
  const end = Math.min(msg.length, 20 + msg.readUInt16BE(2));
  while (off + 4 <= end) {
    const type = msg.readUInt16BE(off);
    const vlen = msg.readUInt16BE(off + 2);
    off += 4;
    if (off + vlen > msg.length) break;
    map.set(type, msg.subarray(off, off + vlen));
    off += vlen + ((4 - (vlen % 4)) % 4);
  }
  return map;
}

function md5CredKey(username: string, realm: string, password: string): Buffer {
  return createHash("md5").update(`${username}:${realm}:${password}`).digest();
}

function encodeXorIpv4(ip: string, port: number, txnId: Buffer): Buffer {
  const buf = Buffer.alloc(8);
  buf[1] = 0x01;
  buf.writeUInt16BE(port ^ (STUN_MAGIC >>> 16), 2);
  const parts = ip.split(".").map((p) => Number(p));
  const magic = Buffer.alloc(4);
  magic.writeUInt32BE(STUN_MAGIC, 0);
  for (let i = 0; i < 4; i++) {
    buf[4 + i] = (parts[i] ?? 0) ^ magic[i];
  }
  void txnId;
  return buf;
}

function parseXorIpv4(attr: Buffer): { ip: string; port: number } | undefined {
  if (!attr || attr.length < 8 || attr[1] !== 0x01) return undefined;
  const port = attr.readUInt16BE(2) ^ (STUN_MAGIC >>> 16);
  const magic = Buffer.alloc(4);
  magic.writeUInt32BE(STUN_MAGIC, 0);
  const parts = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    parts[i] = attr[4 + i] ^ magic[i];
  }
  return { ip: parts.join("."), port };
}

function buildStun(
  method: number,
  cls: number,
  txnId: Buffer,
  attrs: Buffer[],
  creds?: TurnCreds
): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(stunType(method, cls), 0);
  header.writeUInt32BE(STUN_MAGIC, 4);
  txnId.copy(header, 8);
  if (!creds) {
    const body = Buffer.concat(attrs);
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const authBody = Buffer.concat([
    ...attrs,
    tlv(ATTR_USERNAME, Buffer.from(creds.username, "utf8")),
    tlv(ATTR_REALM, Buffer.from(creds.realm, "utf8")),
    tlv(ATTR_NONCE, Buffer.from(creds.nonce, "utf8")),
  ]);
  header.writeUInt16BE(authBody.length + 24, 2);
  const forHmac = Buffer.concat([header, authBody]);
  const key = md5CredKey(creds.username, creds.realm, creds.password);
  const mi = createHmac("sha1", key).update(forHmac).digest();
  return Buffer.concat([forHmac, tlv(ATTR_MESSAGE_INTEGRITY, mi)]);
}

function buildBindingRequest(): Buffer {
  const txnId = randomBytes(12);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(stunType(METHOD_BINDING, CLASS_REQUEST), 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt32BE(STUN_MAGIC, 4);
  txnId.copy(header, 8);
  return header;
}

function buildChannelData(channel: number, data: Buffer): Buffer {
  const pad = (4 - (data.length % 4)) % 4;
  const buf = Buffer.alloc(4 + data.length + pad);
  buf.writeUInt16BE(channel, 0);
  buf.writeUInt16BE(data.length, 2);
  data.copy(buf, 4);
  return buf;
}

function errorCode(attrs: Map<number, Buffer>): number {
  const err = attrs.get(ATTR_ERROR_CODE);
  if (!err || err.length < 4) return 0;
  return err[2] * 100 + err[3];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Phone-like TURN wake: Allocate + permission/bind + UDP burst to relayed address.
 */
export async function turnAllocateWake(
  turn: RtcTurnConfig,
  timeoutOrOpts: number | TurnAllocateWakeOptions = 8000
): Promise<TurnAllocateWakeResult> {
  const opts: TurnAllocateWakeOptions =
    typeof timeoutOrOpts === "number" ? { timeoutMs: timeoutOrOpts } : timeoutOrOpts;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const burstMs = opts.burstMs ?? Number(process.env.RTC_TURN_BURST_MS ?? 2500);
  const peerIps = (opts.peerIps ?? []).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));

  const host = turn.turn_addr;
  const port = turn.turn_port || 3478;
  const username = turn.turn_user;
  const password = turn.turn_password;
  if (!host || !username || !password) {
    rootHTTPLogger.warn("TURN allocate wake skipped — missing credentials");
    return { ok: false, detail: "missing_credentials" };
  }

  rootHTTPLogger.info("TURN allocate wake starting", {
    host,
    port,
    username: `${username.slice(0, 8)}…`,
    peerIps,
    burstMs,
  });

  const sock = dgram.createSocket("udp4");
  const started = Date.now();
  let creds: TurnCreds | undefined;
  let allocateTxn = randomBytes(12);
  let pending:
    | {
        method: number;
        resolve: (msg: Buffer) => void;
        reject: (err: Error) => void;
      }
    | undefined;

  const waitResponse = (method: number, ms: number): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending?.method === method) pending = undefined;
        reject(new Error(`timeout waiting method ${method}`));
      }, ms);
      pending = {
        method,
        resolve: (msg) => {
          clearTimeout(timer);
          pending = undefined;
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          pending = undefined;
          reject(err);
        },
      };
    });

  sock.on("message", (msg) => {
    if (msg.length < 20 || !pending) return;
    // ChannelData responses are not STUN — ignore for pending
    if (msg[0] >= 0x40) return;
    const type = msg.readUInt16BE(0);
    const method = decodeMethod(type);
    if (method !== pending.method) return;
    pending.resolve(msg);
  });

  const send = (buf: Buffer, toHost = host, toPort = port): Promise<void> =>
    new Promise((resolve, reject) => {
      sock.send(buf, toPort, toHost, (err) => (err ? reject(err) : resolve()));
    });

  const request = async (method: number, attrs: Buffer[], useCreds = true): Promise<Buffer> => {
    const txnId = method === METHOD_ALLOCATE && !creds ? allocateTxn : randomBytes(12);
    if (method === METHOD_ALLOCATE && !creds) allocateTxn = txnId;
    const remaining = Math.max(500, timeoutMs - (Date.now() - started));
    const wait = waitResponse(method, Math.min(4000, remaining));
    await send(buildStun(method, CLASS_REQUEST, txnId, attrs, useCreds ? creds : undefined));
    return wait;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.bind(0, () => resolve());
    });

    // 1) Unauthenticated Allocate → 401
    {
      const msg = await request(
        METHOD_ALLOCATE,
        [tlv(ATTR_REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0]))],
        false
      );
      const cls = decodeClass(msg.readUInt16BE(0));
      const attrs = parseAttrs(msg);
      if (cls !== CLASS_ERROR || errorCode(attrs) !== 401) {
        return { ok: false, detail: `unexpected_unauth_${cls}_${errorCode(attrs)}` };
      }
      const realm = attrs.get(ATTR_REALM)?.toString("utf8") ?? "";
      const nonce = attrs.get(ATTR_NONCE)?.toString("utf8") ?? "";
      if (!realm || !nonce) {
        return { ok: false, detail: "401_missing_realm_nonce" };
      }
      creds = { username, realm, nonce, password };
      rootHTTPLogger.info("TURN allocate wake got 401 — retrying with credentials", { realm });
    }

    // 2) Authenticated Allocate
    let relayedHost: string | undefined;
    let relayedPort: number | undefined;
    {
      const msg = await request(METHOD_ALLOCATE, [
        tlv(ATTR_REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0])),
        tlv(ATTR_LIFETIME, (() => {
          const b = Buffer.alloc(4);
          b.writeUInt32BE(300, 0);
          return b;
        })()),
      ]);
      const cls = decodeClass(msg.readUInt16BE(0));
      const attrs = parseAttrs(msg);
      if (cls === CLASS_ERROR) {
        const code = errorCode(attrs);
        if (code === 438) {
          const nonce = attrs.get(ATTR_NONCE)?.toString("utf8");
          if (nonce && creds) creds.nonce = nonce;
        }
        return { ok: false, detail: `allocate_error_${code}` };
      }
      if (cls !== CLASS_SUCCESS) {
        return { ok: false, detail: `allocate_class_${cls}` };
      }
      const relayed = parseXorIpv4(attrs.get(ATTR_XOR_RELAYED_ADDRESS) ?? Buffer.alloc(0));
      const mapped = parseXorIpv4(attrs.get(ATTR_XOR_MAPPED_ADDRESS) ?? Buffer.alloc(0));
      relayedHost = relayed?.ip;
      relayedPort = relayed?.port;
      const newNonce = attrs.get(ATTR_NONCE)?.toString("utf8");
      if (newNonce && creds) creds.nonce = newNonce;
      rootHTTPLogger.info("TURN allocate wake allocate_ok", {
        relayedHost,
        relayedPort,
        mappedHost: mapped?.ip,
        mappedPort: mapped?.port,
      });
    }

    // Default peer: hub-ish targets + mapped/relayed so CreatePermission has something
    const peers = [...new Set(peerIps)];
    if (relayedHost) peers.push(relayedHost);

    let createPermissionOk = false;
    let channelBindOk = false;
    let boundChannel = 0x4000;
    let boundPeer = peers[0];

    // 3) CreatePermission for each peer
    for (const peerIp of peers.slice(0, 4)) {
      try {
        const txnId = randomBytes(12);
        const msg = await (async () => {
          const remaining = Math.max(500, timeoutMs - (Date.now() - started));
          const wait = waitResponse(METHOD_CREATE_PERMISSION, Math.min(3000, remaining));
          await send(
            buildStun(
              METHOD_CREATE_PERMISSION,
              CLASS_REQUEST,
              txnId,
              [tlv(ATTR_XOR_PEER_ADDRESS, encodeXorIpv4(peerIp, 0, txnId))],
              creds
            )
          );
          return wait;
        })();
        const cls = decodeClass(msg.readUInt16BE(0));
        const attrs = parseAttrs(msg);
        if (cls === CLASS_SUCCESS) {
          createPermissionOk = true;
          boundPeer = peerIp;
          rootHTTPLogger.info("TURN create permission ok", { peerIp });
        } else {
          const code = errorCode(attrs);
          if (code === 438) {
            const nonce = attrs.get(ATTR_NONCE)?.toString("utf8");
            if (nonce && creds) creds.nonce = nonce;
          }
          rootHTTPLogger.warn("TURN create permission failed", { peerIp, code });
        }
      } catch (err) {
        rootHTTPLogger.warn("TURN create permission error", {
          peerIp,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 4) ChannelBind for first successful/preferred peer
    if (boundPeer) {
      try {
        const txnId = randomBytes(12);
        const chBuf = Buffer.alloc(4);
        chBuf.writeUInt16BE(boundChannel, 0);
        const remaining = Math.max(500, timeoutMs - (Date.now() - started));
        const wait = waitResponse(METHOD_CHANNEL_BIND, Math.min(3000, remaining));
        await send(
          buildStun(
            METHOD_CHANNEL_BIND,
            CLASS_REQUEST,
            txnId,
            [
              tlv(ATTR_CHANNEL_NUMBER, chBuf),
              tlv(ATTR_XOR_PEER_ADDRESS, encodeXorIpv4(boundPeer, 3478, txnId)),
            ],
            creds
          )
        );
        const msg = await wait;
        const cls = decodeClass(msg.readUInt16BE(0));
        if (cls === CLASS_SUCCESS) {
          channelBindOk = true;
          rootHTTPLogger.info("TURN channel bind ok", { peerIp: boundPeer, channel: boundChannel });
        } else {
          rootHTTPLogger.warn("TURN channel bind failed", {
            peerIp: boundPeer,
            code: errorCode(parseAttrs(msg)),
          });
        }
      } catch (err) {
        rootHTTPLogger.warn("TURN channel bind error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 5) Burst toward relayed address + ChannelData/Send via TURN (phone-like volume)
    let burstPackets = 0;
    const burstUntil = Date.now() + burstMs;
    const binding = buildBindingRequest();
    while (Date.now() < burstUntil && Date.now() - started < timeoutMs) {
      try {
        if (relayedHost && relayedPort) {
          await send(binding, relayedHost, relayedPort);
          burstPackets++;
        }
        if (channelBindOk) {
          await send(buildChannelData(boundChannel, binding));
          burstPackets++;
        } else if (boundPeer) {
          const txnId = randomBytes(12);
          // Send indication — no MESSAGE-INTEGRITY (RFC 5766 indication).
          await send(
            buildStun(METHOD_SEND, CLASS_INDICATION, txnId, [
              tlv(ATTR_XOR_PEER_ADDRESS, encodeXorIpv4(boundPeer, 3478, txnId)),
              tlv(ATTR_DATA, binding),
            ])
          );
          burstPackets++;
        } else {
          // Keep Allocate path warm
          await send(binding, host, port);
          burstPackets++;
        }
      } catch {
        break;
      }
      await sleep(25);
    }

    const result: TurnAllocateWakeResult = {
      ok: true,
      detail: "allocate_ok",
      relayedHost,
      relayedPort,
      createPermissionOk,
      channelBindOk,
      burstPackets,
    };
    rootHTTPLogger.info("TURN allocate wake finished", result);
    return result;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    rootHTTPLogger.info("TURN allocate wake finished", { ok: false, detail, host, port });
    return { ok: false, detail };
  } finally {
    try {
      sock.close();
    } catch {
      /* ignore */
    }
  }
}
