/** Portal (security.eufy.com) SCTP command framing — XZYH header + payload. */

export interface PortalCommandRequest {
  commandID: number;
  channelID: number;
  cmd?: number;
  segmen?: number;
  isResponse?: number;
  devType?: number;
  payload: Record<string, unknown>;
}

export interface PortalCommandResponse {
  commandID: number;
  segmen: number;
  isResponse: number;
  linkType: number;
  errCode?: number;
  cmd?: number;
  data?: unknown;
}

const MAGIC = Buffer.from("XZYH", "ascii");

/** Little-endian fixed-width integer → buffer (portal Ur()). */
function encodeLe(value: number, width: number): Buffer {
  const buf = Buffer.alloc(width);
  let v = value >>> 0;
  for (let i = 0; i < width; i++) {
    buf[i] = v & 0xff;
    v >>>= 8;
  }
  return buf;
}

/** Portal Gr() — 16-byte command header. */
export function buildPortalHeader(
  commandID: number,
  paramLen: number,
  channelID: number,
  segmen: number,
  isResponse = 0,
  devType = 2
): Buffer {
  const header = Buffer.alloc(16);
  MAGIC.copy(header, 0);
  encodeLe(commandID, 2).copy(header, 4);
  encodeLe(paramLen, 4).copy(header, 6);
  header[10] = 0;
  header[11] = segmen & 0xff;
  header[12] = channelID & 0xff;
  header[13] = 0;
  header[14] = isResponse & 0xff;
  header[15] = devType & 0xff;
  return header;
}

/** Portal Qr() — parse 16-byte header. */
export function parsePortalHeader(buf: Buffer): {
  commandID: number;
  paramLen: number;
  segmen: number;
  channelID: number;
  isResponse: number;
  devType: number;
} {
  if (buf.length < 16 || buf.subarray(0, 4).compare(MAGIC) !== 0) {
    throw new Error("Invalid portal packet header");
  }
  return {
    commandID: buf.readUInt16LE(4),
    paramLen: buf.readUInt32LE(6),
    segmen: buf[11],
    channelID: buf[12],
    isResponse: buf[14],
    devType: buf[15],
  };
}

const PARAM_TWO_INT_COMMANDS = new Set([
  1103, 1252, 1214, 1207, 1230, 1056, 1200, 1240, 1241, 1400, 1401, 9257, 1403, 1015, 1035,
]);

function encodeStructuredTwoInt(payload: Record<string, unknown>, account?: string): Buffer {
  const body = Buffer.alloc(136);
  body.writeUInt32LE(Number(payload.value ?? 0), 0);
  body.writeUInt32LE(Number(payload.value1 ?? 0), 4);
  const acct = String(account ?? payload.account ?? payload.account_id ?? "");
  body.write(acct, 8, Math.min(128, acct.length), "utf8");
  return body;
}

function encodePayloadBody(commandID: number, payload: Record<string, unknown>): Buffer {
  if (PARAM_TWO_INT_COMMANDS.has(commandID)) {
    return encodeStructuredTwoInt(payload, String(payload.account_id ?? payload.account ?? ""));
  }
  return Buffer.from(JSON.stringify(payload), "utf8");
}

/** Build a complete portal command packet (header + body). */
export function buildPortalPacket(req: PortalCommandRequest): Buffer {
  const body = encodePayloadBody(req.commandID, req.payload);
  const header = buildPortalHeader(
    req.commandID,
    body.length,
    req.channelID,
    req.segmen ?? 0,
    req.isResponse ?? 0,
    req.devType ?? 2
  );
  return Buffer.concat([header, body]);
}

function parseErrCode(buf: Buffer): number {
  if (buf.length < 4) {
    return -1;
  }
  return buf.readInt32LE(0);
}

function parseJsonBody(buf: Buffer): unknown {
  let text = buf.toString("utf8");
  while (text.endsWith("\0")) {
    text = text.slice(0, -1);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Parse inbound portal packet from WebrtcDataChannel. linkType 1 = response, 3 = nested cmd. */
export function parsePortalPacket(buf: Buffer, linkType = 1): PortalCommandResponse | null {
  if (buf.length < 16 || buf.subarray(0, 4).compare(MAGIC) !== 0) {
    return null;
  }
  const header = parsePortalHeader(buf);
  const body = buf.subarray(16, 16 + header.paramLen);
  if (linkType === 3) {
    const parsed = parseJsonBody(body);
    const cmd =
      typeof parsed === "object" && parsed !== null && "cmd" in parsed
        ? Number((parsed as { cmd?: number }).cmd)
        : undefined;
    return {
      commandID: header.commandID,
      segmen: header.segmen,
      isResponse: header.isResponse,
      linkType,
      cmd,
      data: parsed,
    };
  }
  return {
    commandID: header.commandID,
    segmen: header.segmen,
    isResponse: header.isResponse,
    linkType,
    errCode: parseErrCode(body),
    data: body.length > 4 ? parseJsonBody(body.subarray(4)) : undefined,
  };
}
