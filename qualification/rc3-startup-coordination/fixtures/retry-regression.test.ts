import { createECDH } from 'crypto';
import { MegaHTTPApi, megaLoginHash, type MegaSession } from 'subject/src/http/megaApi';
import { megaDecryptBody, megaEncryptBody, presetDecrypt, presetEncrypt, sharedKeyToAesKey, type MegaIdentity } from 'subject/src/http/megaCrypto';
import { ResponseErrorCode } from 'subject/src/http/types';
jest.mock('subject/src/logging', () => {
  const stub = { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), trace: jest.fn() };
  return new Proxy({}, { get: () => stub });
});
jest.mock('node-datachannel', () => ({ __esModule: true, default: {} }));
import { EufySecurity } from 'subject/src/eufysecurity';

const host = 'app-openapi-eu-pr.eufy.com';
const oldIdentity: MegaIdentity = { keyIdent: '00112233445566778899aabbccddeeff',
  sharedKey: 'a379aa6966ef2eac85b65201f85213399ccb9a8692edb9eb333030c8bdfba364', clientPublicKey: '04' };
const config = { username: 'synthetic@example.invalid', password: 'synthetic-test-only', country: 'fr' };
const openudid = '00000000000000000000000000000001';
const originalSession = (): MegaSession => ({ ab: 'fr', openudid,
  login_hash: megaLoginHash(config.username, config.password, openudid),
  cloud_token: 'synthetic-expired-token', user_id: 'synthetic-user', cloud_token_expiration: 1,
  megaDomain: 'mega-eu-pr.eufy.com', domains: {}, identities: { [host]: { ...oldIdentity } } });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
type Stage = 'estimate' | 'exchange' | 'exchange-error' | 'verify' | 'captcha' |
  number | { code: number; faStep?: number; hold?: Promise<void>; notify?: () => void; replace?: () => void } | 'login-error';
type Trace = { path: string; key?: string; nonce?: string; signature?: string; payload?: any };

function transport(api: MegaHTTPApi, stages: Stage[], hooks?: { exchange?: () => void }) {
  const pending = [...stages];
  const requests: Trace[] = [];
  const errors: string[] = [];
  let secret = oldIdentity.sharedKey;
  (api as any).got = jest.fn(async (url: string, opts: any) => {
    try {
      const { pathname, hostname } = new URL(url);
      const stage = pending.shift();
      const row: Trace = { path: pathname, key: opts.headers?.['x-key-ident'],
        nonce: opts.headers?.['x-request-once'], signature: opts.headers?.['x-signature'] };
      requests.push(row);
      let result: any;
      if (stage === 'estimate') {
        expect(hostname).toBe('mega-eu-pr.eufy.com');
        expect(pathname).toBe('/passport/estimate_domain');
        result = { code: 0, data: { domain: 'mega-eu-pr.eufy.com', product_domains: {} } };
      } else if (stage === 'exchange' || stage === 'exchange-error') {
        expect(hostname).toBe(host);
        expect(pathname).toBe('/openapi/oauth/key/exchange');
        expect(opts.retry.limit).toBe(0);
        if (stage === 'exchange-error') return { statusCode: 200, body: JSON.stringify({ code: 4404, msg: 'synthetic negotiation failure' }) };
        const server = createECDH('prime256v1');
        server.generateKeys();
        const clientPublic = presetDecrypt(JSON.parse(opts.body).client_public_key);
        secret = server.computeSecret(Buffer.from(clientPublic, 'hex')).toString('hex');
        result = { code: 0, data: { server_public_key: presetEncrypt(server.getPublicKey('hex')) } };
        hooks?.exchange?.();
      } else if (stage === 'verify' || stage === 'captcha') {
        expect(hostname).toBe(`app-${stage === 'verify' ? 'push' : 'passport'}-eu-pr.eufy.com`);
        expect(pathname).toBe(stage === 'verify' ? '/app/sendmsg/verify_code' : '/passport/generate/captcha');
        result = { code: 0, data: stage === 'captcha' ? { captcha_id: 'synthetic-captcha', item: 'synthetic-image' } : {} };
      } else if (typeof stage === 'number' || typeof stage === 'object' || stage === 'login-error') {
        expect(hostname).toBe('app-passport-eu-pr.eufy.com');
        expect(pathname).toBe('/passport/login');
        expect(opts.retry.limit).toBe(0);
        row.payload = JSON.parse(megaDecryptBody(opts.body, sharedKeyToAesKey(secret)));
        if (stage === 'login-error') throw new Error('synthetic transport failure');
        const code = typeof stage === 'number' ? stage : stage.code;
        if (typeof stage === 'object') {
          stage.notify?.();
          if (stage.hold) await stage.hold;
          stage.replace?.();
        }
        result = { code, msg: 'synthetic' };
        if (code === 0) result.data = megaEncryptBody(JSON.stringify({
          auth_token: 'synthetic-new-token', user_id: 'synthetic-user', token_expires_at: 9999999999,
          ...(typeof stage === 'object' && stage.faStep ? { fa_info: { step: stage.faStep } } : {}),
        }), sharedKeyToAesKey(secret));
      } else throw new Error(`Unexpected synthetic request: ${pathname}`);
      return { statusCode: 200, body: opts.responseType === 'json' ? result : JSON.stringify(result) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== 'synthetic transport failure') errors.push(message);
      throw error;
    }
  });
  (api as any).throttle = (fn: any) => fn;
  return { requests, paths: () => requests.map(row => row.path), assertConsumed: () => {
    expect(errors).toEqual([]);
    expect(pending).toEqual([]);
  } };
}

function context(api = new MegaHTTPApi({ ab: 'fr', openudid, minRequestIntervalMs: 0 })) {
  const saved = originalSession();
  const serialized = JSON.stringify(saved);
  const persistentData: any = { openudid, megaApi: JSON.parse(serialized) };
  api.restoreSession(persistentData.megaApi);
  let active = 0;
  let maximum = 0;
  const ctx: any = { config, megaApi: api, persistentData,
    getMegaApi: jest.fn(async () => ctx.megaApi), emit: jest.fn(), writePersistentData: jest.fn(),
    syncMegaRtcCredentialsToApi: jest.fn(), resumeStationsAfterMegaAuthRecovery: jest.fn(),
    syncMegaPushRegistration: jest.fn().mockResolvedValue(undefined),
  };
  if ((EufySecurity.prototype as any).loginMegaAttempt) {
    ctx.loginMegaAttempt = jest.fn(async function (this: any, code?: string, captcha?: any, owner?: any) {
      active++;
      maximum = Math.max(maximum, active);
      try { return await (EufySecurity.prototype as any).loginMegaAttempt.call(this, code, captcha, owner); }
      finally { active--; }
    });
  }
  return { api, ctx, serialized, persistentData, maximum: () => maximum };
}
const login = (c: ReturnType<typeof context>, code?: string, captcha?: any) => EufySecurity.prototype.loginMega.call(c.ctx, code, captcha);
function unchanged(c: ReturnType<typeof context>, allowEmit = false) {
  expect(JSON.stringify(c.persistentData.megaApi)).toBe(c.serialized);
  expect(c.ctx.writePersistentData).not.toHaveBeenCalled();
  expect(c.ctx.syncMegaRtcCredentialsToApi).not.toHaveBeenCalled();
  expect(c.ctx.resumeStationsAfterMegaAuthRecovery).not.toHaveBeenCalled();
  expect(c.ctx.syncMegaPushRegistration).not.toHaveBeenCalled();
  if (!allowEmit) expect(c.ctx.emit).not.toHaveBeenCalled();
  expect(c.ctx.megaInitialLogin).toBeUndefined();
  expect(c.ctx.megaLoginTail).toBeUndefined();
}
const retried = ['/passport/estimate_domain', '/passport/login', '/openapi/oauth/key/exchange', '/passport/login'];

describe('Bounded initial Mega login candidate', () => {
  afterEach(() => jest.restoreAllMocks());

  it('4404 performs one fresh handshake and signed retry, then commits successful state once', async () => {
    const c = context();
    const t = transport(c.api, ['estimate', 4404, 'exchange', 0]);
    await expect(login(c)).resolves.toBe('ok');
    expect(t.paths()).toEqual(retried);
    expect(t.requests[3].key).toBe(t.requests[2].key);
    expect(t.requests[3].key).not.toBe(oldIdentity.keyIdent);
    expect(t.requests[3].nonce).not.toBe(t.requests[1].nonce);
    expect(t.requests[3].signature).not.toBe(t.requests[1].signature);
    expect(c.persistentData.megaApi.cloud_token).toBe('synthetic-new-token');
    expect(c.persistentData.megaApi.cloud_token_expiration).toBe(9999999999);
    expect(c.persistentData.megaApi.login_hash).toBe(megaLoginHash(config.username, config.password, openudid));
    expect(c.persistentData.megaApi.identities[host].keyIdent).toBe(t.requests[3].key);
    expect(c.ctx.writePersistentData).toHaveBeenCalledTimes(1);
    expect(c.ctx.syncMegaRtcCredentialsToApi).toHaveBeenCalledTimes(1);
    expect(c.ctx.resumeStationsAfterMegaAuthRecovery).toHaveBeenCalledTimes(1);
    expect(c.ctx.syncMegaPushRegistration).toHaveBeenCalledTimes(1);
    expect(c.ctx.megaLoginTail).toBeUndefined();
    expect(c.ctx.megaInitialLogin).toBeUndefined();
    t.assertConsumed();
  });

  it.each([4404, 4416, -1])('retry response %i stops without another request or saved-data change', async code => {
    const c = context();
    const t = transport(c.api, ['estimate', 4404, 'exchange', code]);
    await expect(login(c)).resolves.toBe('failed');
    expect(t.paths()).toEqual(retried);
    unchanged(c);
    t.assertConsumed();
  });

  it('failed retry negotiation stops before a second login', async () => {
    const c = context();
    const t = transport(c.api, ['estimate', 4404, 'exchange-error']);
    await expect(login(c)).resolves.toBe('failed');
    expect(t.paths()).toEqual(retried.slice(0, 3));
    unchanged(c);
    t.assertConsumed();
  });

  it('retry transport exception stops and releases ownership', async () => {
    const c = context();
    const t = transport(c.api, ['estimate', 4404, 'exchange', 'login-error']);
    await expect(login(c)).resolves.toBe('failed');
    expect(t.paths()).toEqual(retried);
    unchanged(c);
    t.assertConsumed();
  });

  it.each([4416, -1])('initial response %i does not qualify for a retry', async code => {
    const c = context();
    const t = transport(c.api, ['estimate', code]);
    await expect(login(c)).resolves.toBe('failed');
    expect(t.paths()).toEqual(retried.slice(0, 2));
    unchanged(c);
    t.assertConsumed();
  });

  it('initial negotiation error does not qualify for a passport-login retry', async () => {
    const c = context();
    (c.api as any).identities.clear();
    const t = transport(c.api, ['estimate', 'exchange-error']);
    await expect(login(c)).resolves.toBe('failed');
    expect(t.paths()).toEqual(['/passport/estimate_domain', '/openapi/oauth/key/exchange']);
    unchanged(c);
    t.assertConsumed();
  });

  it.each([
    ResponseErrorCode.CODE_PASSWORD_WRONG_FIVE_TIMES, ResponseErrorCode.CODE_PASSWORD_TOO_MANY_INCORRECT,
    ResponseErrorCode.CODE_MAX_LOGIN_LIMIT,
  ])('initial lockout %i stops without negotiation retry', async code => {
    const c = context();
    const t = transport(c.api, ['estimate', code]);
    await expect(login(c)).resolves.toBe('locked');
    expect(t.paths()).toEqual(retried.slice(0, 2));
    unchanged(c);
    t.assertConsumed();
  });

  it.each([
    ResponseErrorCode.CODE_PASSWORD_WRONG_FIVE_TIMES, ResponseErrorCode.CODE_PASSWORD_TOO_MANY_INCORRECT,
    ResponseErrorCode.CODE_MAX_LOGIN_LIMIT,
  ])('lockout %i after retry stops without another request', async code => {
    const c = context();
    const t = transport(c.api, ['estimate', 4404, 'exchange', code]);
    await expect(login(c)).resolves.toBe('locked');
    expect(t.paths()).toEqual(retried);
    unchanged(c);
    t.assertConsumed();
  });

  it.each([false, true])('2FA remains a challenge; retry precedes challenge=%s', async retry => {
    const c = context();
    const stages: Stage[] = retry ? ['estimate', 4404, 'exchange', ResponseErrorCode.CODE_NEED_VERIFY_CODE, 'verify'] :
      ['estimate', ResponseErrorCode.CODE_NEED_VERIFY_CODE, 'verify'];
    const t = transport(c.api, stages);
    await expect(login(c)).resolves.toBe('tfa_required');
    expect(t.paths()).toEqual([...(retry ? retried : retried.slice(0, 2)), '/app/sendmsg/verify_code']);
    unchanged(c);
    t.assertConsumed();
  });

  it.each([false, true])('captcha remains a challenge; retry precedes challenge=%s', async retry => {
    const c = context();
    const stages: Stage[] = retry ? ['estimate', 4404, 'exchange', ResponseErrorCode.LOGIN_NEED_CAPTCHA, 'captcha'] :
      ['estimate', ResponseErrorCode.LOGIN_NEED_CAPTCHA, 'captcha'];
    const t = transport(c.api, stages);
    await expect(login(c)).resolves.toBe('captcha_required');
    expect(t.paths()).toEqual([...(retry ? retried : retried.slice(0, 2)), '/passport/generate/captcha']);
    expect(c.ctx.emit).toHaveBeenCalledWith('captcha request', 'synthetic-captcha', 'synthetic-image');
    unchanged(c, true);
    t.assertConsumed();
  });

  it.each(['synthetic-code', ''])('supplied verification input %p never replays after 4404', async code => {
    const c = context();
    const t = transport(c.api, ['estimate', 4404]);
    await expect(login(c, code)).resolves.toBe('failed');
    expect(t.paths()).toEqual(retried.slice(0, 2));
    expect(t.requests[1].payload.verify_code).toBe(code);
    unchanged(c);
    t.assertConsumed();
  });

  it('supplied captcha never replays after 4404', async () => {
    const c = context();
    const t = transport(c.api, ['estimate', 4404]);
    await expect(login(c, undefined, { captchaId: 'synthetic-id', answer: 'synthetic-answer' })).resolves.toBe('failed');
    expect(t.paths()).toEqual(retried.slice(0, 2));
    expect(t.requests[1].payload.answer).toBe('synthetic-answer');
    unchanged(c);
    t.assertConsumed();
  });

  it('simultaneous initial callers share one bounded authentication attempt', async () => {
    const c = context();
    const hold = deferred();
    const entered = deferred();
    const t = transport(c.api, ['estimate', { code: 4404, hold: hold.promise, notify: entered.resolve }, 'exchange', 0]);
    const first = login(c);
    await entered.promise;
    const second = login(c);
    hold.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(['ok', 'ok']);
    expect(t.paths()).toEqual(retried);
    expect(c.maximum()).toBe(1);
    expect(c.ctx.loginMegaAttempt).toHaveBeenCalledTimes(1);
    expect(c.ctx.writePersistentData).toHaveBeenCalledTimes(1);
    t.assertConsumed();
  });

  it('multiple challenge submissions queue once each, retain order and capture mutable captcha input', async () => {
    const c = context();
    const hold = deferred();
    const entered = deferred();
    const t = transport(c.api, ['estimate', { code: 4404, hold: hold.promise, notify: entered.resolve }, 'exchange', 0,
      'estimate', 0, 'estimate', 0, 'estimate', 0]);
    const initial = login(c);
    await entered.promise;
    const first = login(c, 'synthetic-code-one');
    const second = login(c, 'synthetic-code-two');
    const supplied = { captchaId: 'synthetic-captcha-id', answer: 'before-enqueue' };
    const captcha = login(c, undefined, supplied);
    supplied.answer = 'after-enqueue';
    hold.resolve();
    await expect(Promise.all([initial, first, second, captcha])).resolves.toEqual(['ok', 'ok', 'ok', 'ok']);
    const attempts = t.requests.filter(row => row.path === '/passport/login');
    expect(attempts.map(row => row.payload.verify_code)).toEqual(['', '', 'synthetic-code-one', 'synthetic-code-two', '']);
    expect(attempts[4].payload.answer).toBe('before-enqueue');
    expect(c.maximum()).toBe(1);
    expect(c.ctx.loginMegaAttempt).toHaveBeenCalledTimes(4);
    expect(c.ctx.writePersistentData).toHaveBeenCalledTimes(4);
    expect(c.ctx.megaLoginTail).toBeUndefined();
    t.assertConsumed();
  });

  it('a failed attempt releases the queue for a later explicit initial attempt', async () => {
    const c = context();
    const t = transport(c.api, ['estimate', 4404, 'exchange', 4404, 'estimate', 'exchange', 0]);
    await expect(login(c)).resolves.toBe('failed');
    unchanged(c);
    await expect(login(c)).resolves.toBe('ok');
    expect(c.ctx.loginMegaAttempt).toHaveBeenCalledTimes(2);
    expect(c.ctx.writePersistentData).toHaveBeenCalledTimes(1);
    expect(c.maximum()).toBe(1);
    t.assertConsumed();
  });

  it('client replacement after initial rejection prevents retry and old-owner persistence', async () => {
    const c = context();
    const replacement = new MegaHTTPApi({ ab: 'fr', openudid });
    const t = transport(c.api, ['estimate', { code: 4404, replace: () => { c.ctx.megaApi = replacement; } }]);
    await expect(login(c)).resolves.toBe('failed');
    expect(t.paths()).toEqual(retried.slice(0, 2));
    expect(c.ctx.megaApi).toBe(replacement);
    unchanged(c);
    t.assertConsumed();
  });

  it('client replacement during retry prevents publishing the old successful session', async () => {
    const c = context();
    const replacement = new MegaHTTPApi({ ab: 'fr', openudid });
    const t = transport(c.api, ['estimate', 4404, 'exchange', { code: 0, replace: () => { c.ctx.megaApi = replacement; } }]);
    await expect(login(c)).resolves.toBe('failed');
    expect(t.paths()).toEqual(retried);
    expect(c.ctx.megaApi).toBe(replacement);
    expect(replacement.hasValidSession()).toBe(false);
    unchanged(c);
    t.assertConsumed();
  });

  it.each([false, true])('encrypted provisional 2FA remains unpersisted until explicit completion; retry=%s', async retry => {
    const c = context();
    const response = { code: 0, faStep: ResponseErrorCode.CODE_NEED_VERIFY_CODE };
    const stages: Stage[] = retry ? ['estimate', 4404, 'exchange', response, 'verify', 'estimate', 0] :
      ['estimate', response, 'verify', 'estimate', 0];
    const t = transport(c.api, stages);
    await expect(login(c)).resolves.toBe('tfa_required');
    expect(c.api.hasValidSession()).toBe(true);
    expect(JSON.stringify(c.persistentData.megaApi)).toBe(c.serialized);
    expect(c.ctx.writePersistentData).not.toHaveBeenCalled();
    expect(c.ctx.syncMegaRtcCredentialsToApi).not.toHaveBeenCalled();
    expect(c.ctx.resumeStationsAfterMegaAuthRecovery).not.toHaveBeenCalled();
    expect(t.requests.filter(row => row.path === '/app/sendmsg/verify_code')).toHaveLength(1);
    await expect(login(c, 'synthetic-completion-code')).resolves.toBe('ok');
    expect(t.requests.filter(row => row.path === '/passport/login').at(-1)?.payload.verify_code).toBe('synthetic-completion-code');
    expect(c.ctx.writePersistentData).toHaveBeenCalledTimes(1);
    expect(c.ctx.resumeStationsAfterMegaAuthRecovery).toHaveBeenCalledTimes(1);
    t.assertConsumed();
  });

  it('client replacement during retry negotiation prevents the second login', async () => {
    const c = context();
    const replacement = new MegaHTTPApi({ ab: 'fr', openudid });
    const t = transport(c.api, ['estimate', 4404, 'exchange'], {
      exchange: () => { c.ctx.megaApi = replacement; },
    });
    await expect(login(c)).resolves.toBe('failed');
    expect(t.paths()).toEqual(retried.slice(0, 3));
    unchanged(c);
    t.assertConsumed();
  });

  it('client replacement during initial negotiation prevents the first login', async () => {
    const c = context();
    (c.api as any).identities.clear();
    const replacement = new MegaHTTPApi({ ab: 'fr', openudid });
    const t = transport(c.api, ['estimate', 'exchange'], {
      exchange: () => { c.ctx.megaApi = replacement; },
    });
    await expect(login(c)).resolves.toBe('failed');
    expect(t.paths()).toEqual(['/passport/estimate_domain', '/openapi/oauth/key/exchange']);
    unchanged(c);
    t.assertConsumed();
  });

  it.each([false, true])('a new-owner initial login queues instead of joining an obsolete attempt; cleared=%s', async cleared => {
    const c = context();
    const hold = deferred();
    const entered = deferred();
    const old = transport(c.api, ['estimate', { code: 4404, hold: hold.promise, notify: entered.resolve }]);
    const replacement = new MegaHTTPApi({ ab: 'fr', openudid, minRequestIntervalMs: 0 });
    replacement.restoreSession(originalSession());
    const fresh = transport(replacement, ['estimate', 4404, 'exchange', 0]);
    const first = login(c);
    await entered.promise;
    c.ctx.megaApi = cleared ? undefined : replacement;
    c.ctx.getMegaApi = jest.fn(async () => {
      if (!c.ctx.megaApi) c.ctx.megaApi = replacement;
      return c.ctx.megaApi;
    });
    const recovery = login(c);
    expect(fresh.paths()).toEqual([]);
    hold.resolve();
    await expect(Promise.all([first, recovery])).resolves.toEqual(['failed', 'ok']);
    expect(old.paths()).toEqual(retried.slice(0, 2));
    expect(fresh.paths()).toEqual(retried);
    expect(c.maximum()).toBe(1);
    expect(c.ctx.loginMegaAttempt).toHaveBeenCalledTimes(2);
    expect(c.ctx.writePersistentData).toHaveBeenCalledTimes(1);
    expect(c.ctx.megaApi).toBe(replacement);
    expect(c.ctx.megaLoginTail).toBeUndefined();
    expect(c.ctx.megaInitialLogin).toBeUndefined();
    old.assertConsumed();
    fresh.assertConsumed();
  });

  it('initial callers share the client while its asynchronous initialization is pending', async () => {
    const c = context();
    c.ctx.megaApi = undefined;
    const initializing = deferred();
    const entered = deferred();
    c.ctx.getMegaApi = jest.fn(async () => {
      c.ctx.megaApi = c.api;
      entered.resolve();
      await initializing.promise;
      return c.api;
    });
    const t = transport(c.api, ['estimate', 4404, 'exchange', 0]);
    const first = login(c);
    await entered.promise;
    const second = login(c);
    initializing.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(['ok', 'ok']);
    expect(c.ctx.getMegaApi).toHaveBeenCalledTimes(1);
    expect(c.ctx.loginMegaAttempt).toHaveBeenCalledTimes(1);
    expect(c.ctx.writePersistentData).toHaveBeenCalledTimes(1);
    expect(t.paths()).toEqual(retried);
    t.assertConsumed();
  });
});
