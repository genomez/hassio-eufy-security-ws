import { MegaHTTPApi } from "../megaApi";
import { ResponseErrorCode } from "../types";

jest.mock("../../logging", () => {
  const stub = { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), trace: jest.fn() };
  return new Proxy({}, { get: () => stub });
});

import { EufySecurity } from "../../eufysecurity";

/**
 * Exercises the REAL EufySecurity.loginMega state machine (the one complex orchestration in the v6
 * change) by invoking it off the prototype with a stubbed `this`, covering each branch:
 * valid-session short-circuit, 2FA-required, captcha-required, plain failure, hard error, success.
 */
type MegaStub = Partial<
  Pick<
    MegaHTTPApi,
    | "hasValidSession"
    | "estimateDomain"
    | "keyExchange"
    | "login"
    | "sendVerifyCode"
    | "generateCaptcha"
    | "clusterHost"
    | "exportSession"
  >
>;

function makeCtx(mega: MegaStub, opts?: { getMegaThrows?: boolean }) {
  const emit = jest.fn();
  const writePersistentData = jest.fn();
  const syncMegaRtcCredentialsToApi = jest.fn();
  const persistentData: Record<string, unknown> = {};
  const ctx = {
    config: { username: "a@b.c", password: "pw", country: "fr" },
    megaApi: mega,
    loginMegaAttempt: (EufySecurity.prototype as any).loginMegaAttempt,
    persistentData,
    emit,
    writePersistentData,
    syncMegaRtcCredentialsToApi,
    getMegaApi: jest.fn(async () => {
      if (opts?.getMegaThrows) throw new Error("init failed");
      return mega as MegaHTTPApi;
    }),
  } as unknown as EufySecurity;
  return { ctx, emit, writePersistentData, syncMegaRtcCredentialsToApi, persistentData };
}

const baseMega = (over: MegaStub): MegaStub => ({
  hasValidSession: () => false,
  estimateDomain: jest.fn().mockResolvedValue({}),
  keyExchange: jest.fn().mockResolvedValue({}),
  clusterHost: () => "app-openapi-eu-pr.eufy.com",
  ...over,
});

const loginMega = (ctx: EufySecurity, code?: string, captcha?: { captchaId: string; answer: string }) =>
  (
    EufySecurity.prototype as unknown as {
      loginMega(c?: string, cap?: { captchaId: string; answer: string }): Promise<string>;
    }
  ).loginMega.call(ctx, code, captcha);

describe("EufySecurity.loginMega", () => {
  afterEach(() => jest.clearAllMocks());

  it("short-circuits to ok when a valid session already exists", async () => {
    const mega = baseMega({ hasValidSession: () => true, login: jest.fn() });
    const { ctx } = makeCtx(mega);
    await expect(loginMega(ctx)).resolves.toBe("ok");
    expect(mega.login).not.toHaveBeenCalled();
  });

  it("returns tfa_required and sends the verify code on 26052", async () => {
    const sendVerifyCode = jest.fn().mockResolvedValue({ code: 0 });
    const mega = baseMega({
      login: jest.fn().mockResolvedValue({ code: ResponseErrorCode.CODE_NEED_VERIFY_CODE }),
      sendVerifyCode,
    });
    const { ctx } = makeCtx(mega);
    await expect(loginMega(ctx)).resolves.toBe("tfa_required");
    expect(sendVerifyCode).toHaveBeenCalled();
  });

  it("returns captcha_required and emits 'captcha request' on 100032", async () => {
    const mega = baseMega({
      login: jest.fn().mockResolvedValue({ code: ResponseErrorCode.LOGIN_NEED_CAPTCHA }),
      generateCaptcha: jest.fn().mockResolvedValue({ captcha_id: "CID", item: "img" }),
    });
    const { ctx, emit } = makeCtx(mega);
    await expect(loginMega(ctx)).resolves.toBe("captcha_required");
    expect(emit).toHaveBeenCalledWith("captcha request", "CID", "img");
  });

  it("returns failed on a non-zero/non-handled login code", async () => {
    const mega = baseMega({
      login: jest.fn().mockResolvedValue({ code: ResponseErrorCode.MULTIPLE_EMAIL_PASSWORD_ERROR }),
    });
    const { ctx, writePersistentData } = makeCtx(mega);
    await expect(loginMega(ctx)).resolves.toBe("failed");
    expect(writePersistentData).not.toHaveBeenCalled();
  });

  it("returns locked on a backend lockout code (no retry, no verify-code resend)", async () => {
    const sendVerifyCode = jest.fn();
    const mega = baseMega({
      login: jest.fn().mockResolvedValue({ code: ResponseErrorCode.CODE_PASSWORD_WRONG_FIVE_TIMES }),
      sendVerifyCode,
    });
    const { ctx, writePersistentData } = makeCtx(mega);
    await expect(loginMega(ctx)).resolves.toBe("locked");
    expect(sendVerifyCode).not.toHaveBeenCalled();
    expect(writePersistentData).not.toHaveBeenCalled();
  });

  it("returns failed (never throws) when getMegaApi throws", async () => {
    const { ctx } = makeCtx({}, { getMegaThrows: true });
    await expect(loginMega(ctx)).resolves.toBe("failed");
  });

  it("persists the session and returns ok on success", async () => {
    const mega = baseMega({
      login: jest.fn().mockResolvedValue({ code: 0 }),
      exportSession: jest.fn().mockReturnValue({ ab: "fr", openudid: "x", cloud_token: "t" }),
    });
    const { ctx, writePersistentData, syncMegaRtcCredentialsToApi, persistentData } = makeCtx(mega);
    await expect(loginMega(ctx, "123456")).resolves.toBe("ok");
    expect(mega.exportSession).toHaveBeenCalled();
    expect(persistentData.megaApi).toEqual({ ab: "fr", openudid: "x", cloud_token: "t" });
    expect(writePersistentData).toHaveBeenCalled();
    expect(syncMegaRtcCredentialsToApi).toHaveBeenCalledWith(persistentData.megaApi);
  });
});
