jest.mock("../../logging", () => {
  const stub = { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), trace: jest.fn() };
  return new Proxy({}, { get: () => stub });
});

import {
  defaultSignalingRegionForCountry,
  isRevokedMegaTokenSignError,
  RtcSignalingClient,
  RtcSignalingFetchError,
} from "../rtcSignaling";

describe("RtcSignalingClient regional signaling context", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it("uses the EU host and web portal headers for FR", async () => {
    const phases: string[] = [];
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: "sign-value" }),
    } as Response);
    const client = new RtcSignalingClient({
      authToken: "secret-auth-token",
      gtoken: "secret-gtoken",
      stationSn: "station",
      region: "FR",
    });

    await expect(client.fetchSign({ reportPhase: (phase) => phases.push(phase) })).resolves.toBe("sign-value");

    expect(fetchMock).toHaveBeenCalledWith("https://security-smart-eu.eufylife.com/v1/smart/nvr/ws/sign", {
      headers: {
        "Web-Country": "FR",
        "X-Auth-Token": "secret-auth-token",
        "App-Name": "eufy_mega",
        "Model-Type": "WEB",
        GToken: "secret-gtoken",
        Origin: "https://security.eufy.com",
      },
    });
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("Country");
    expect(headers).not.toHaveProperty("Language");
    expect(headers).not.toHaveProperty("X-Auth-User");
    expect(phases).toEqual([
      "fetch_sign_request_dispatching",
      "fetch_sign_request_dispatched",
      "fetch_sign_response_headers",
      "fetch_sign_body_read_start",
      "fetch_sign_body_read_complete",
    ]);
  });

  it("reports and rejects an explicitly aborted sign request", async () => {
    const phases: string[] = [];
    const abortController = new AbortController();
    jest.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
          { once: true }
        );
      });
    });
    const client = new RtcSignalingClient({
      authToken: "test-auth-token",
      gtoken: "test-gtoken",
      stationSn: "station",
      region: "FR",
    });
    const request = client.fetchSign({
      signal: abortController.signal,
      reportPhase: (phase) => phases.push(phase),
    });

    abortController.abort(new Error("test sign abort"));

    await expect(request).rejects.toThrow("test sign abort");
    expect(phases).toEqual([
      "fetch_sign_request_dispatching",
      "fetch_sign_request_dispatched",
      "fetch_sign_request_aborted",
    ]);
  });

  it("classifies only the exact revoked Mega token sign response", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ code: 401, msg: "token does not exist because it was kicked out" }),
    } as Response);
    const client = new RtcSignalingClient({
      authToken: "secret-auth-token",
      gtoken: "secret-gtoken",
      stationSn: "station",
      region: "FR",
    });

    const error = await client.fetchSign().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RtcSignalingFetchError);
    expect(isRevokedMegaTokenSignError(error)).toBe(true);
    expect((error as Error).message).toBe("RtcSignaling fetchSign failed: HTTP 401 revoked mega token");
    expect((error as Error).message).not.toContain("secret-auth-token");
  });

  it("classifies the shorter token-not-exist sign response", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ code: 401, msg: "token not exist" }),
    } as Response);
    const client = new RtcSignalingClient({
      authToken: "secret-auth-token",
      gtoken: "secret-gtoken",
      stationSn: "station",
      region: "FR",
    });

    const error = await client.fetchSign().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RtcSignalingFetchError);
    expect(isRevokedMegaTokenSignError(error)).toBe(true);
    expect((error as Error).message).toBe("RtcSignaling fetchSign failed: HTTP 401 revoked mega token");
    expect((error as Error).message).not.toContain("secret-auth-token");
  });

  it("does not classify an unrelated HTTP 401 as a revoked Mega token", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ code: 401, msg: "unauthorized" }),
    } as Response);
    const client = new RtcSignalingClient({
      authToken: "secret-auth-token",
      gtoken: "secret-gtoken",
      stationSn: "station",
      region: "FR",
    });

    const error = await client.fetchSign().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RtcSignalingFetchError);
    expect(isRevokedMegaTokenSignError(error)).toBe(false);
  });

  it("retains the current default host outside the isolated FR test", () => {
    const client = new RtcSignalingClient({
      authToken: "secret-auth-token",
      gtoken: "secret-gtoken",
      stationSn: "station",
      region: "US",
    });

    expect(client.getWsUrl()).toBe("wss://security-smart.eufylife.com/v1/rtc/ws/join?reqtype=nvr");
  });

  it("preserves an explicit signaling-host override", () => {
    const client = new RtcSignalingClient({
      authToken: "secret-auth-token",
      gtoken: "secret-gtoken",
      stationSn: "station",
      region: "FR",
      smartHost: "signaling.test.invalid",
    });

    expect(client.getWsUrl()).toBe("wss://signaling.test.invalid/v1/rtc/ws/join?reqtype=nvr");
  });

  it("uses the EU cluster in the FR WebSocket auth payload", () => {
    expect(defaultSignalingRegionForCountry("FR")).toBe("EU");
    expect(defaultSignalingRegionForCountry(" fr ")).toBe("EU");
    expect(defaultSignalingRegionForCountry("US")).toBe("US");
    expect(defaultSignalingRegionForCountry()).toBe("US");
  });
});
