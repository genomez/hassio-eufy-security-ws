jest.mock("../../logging", () => {
  const stub = { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), trace: jest.fn() };
  return new Proxy({}, { get: () => stub });
});

import { rootP2PLogger } from "../../logging";
import { CommandType } from "../../p2p/types";
import { dispatchPortalDatabaseInbound, StationDatabaseInboundSession } from "../stationDatabaseInbound";

const session = {
  getStationSn: () => "station",
  emit: jest.fn(),
} as unknown as StationDatabaseInboundSession;

describe("dispatchPortalDatabaseInbound", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it.each(["", "  \r\n", "\0\0"])("ignores an empty database payload without a parse warning", (payload) => {
    expect(dispatchPortalDatabaseInbound(session, undefined, undefined, payload, CommandType.CMD_DATABASE)).toBe(false);

    expect(rootP2PLogger.debug).not.toHaveBeenCalledWith("JSON parse error", expect.anything());
    expect(session.emit).not.toHaveBeenCalled();
  });

  it("retains diagnostics for malformed nonempty JSON", () => {
    expect(dispatchPortalDatabaseInbound(session, undefined, undefined, "{", CommandType.CMD_DATABASE)).toBe(false);

    expect(rootP2PLogger.debug).toHaveBeenCalledWith("JSON parse error", expect.objectContaining({ data: "{" }));
    expect(session.emit).not.toHaveBeenCalled();
  });
});
