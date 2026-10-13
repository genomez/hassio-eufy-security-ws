// @ts-nocheck
const { createLoader } = require('./module-loader.cjs');
const { apiContext } = require('./contexts.cjs');
const poisoned = code => ({ code, msg: 'FAKE_SECRET_BACKEND_MESSAGE', data: {
  token: 'FAKE_SECRET_BODY_TOKEN', nested: { password: 'FAKE_SECRET_PASSWORD', headers: 'FAKE_SECRET_HEADERS' },
} });
function safeLogs(c) {
  const serialized = JSON.stringify(c.loader.logs);
  expect(serialized).not.toContain('FAKE_SECRET');
  for (const row of c.loader.logs.filter(row => row.args[0] === 'Legacy push request')) {
    expect(Object.keys(row.args[1]).every(key => ['operation', 'category', 'httpStatus', 'backendCode', 'errorClass'].includes(key))).toBe(true);
    for (const value of Object.values(row.args[1])) expect(['string', 'number'].includes(typeof value)).toBe(true);
  }
  expect(c.loader.denied).toEqual([]);
}
const tokenCall = (c, method) => method === 'check' ? c.api.checkPushToken() : c.api.registerPushToken('FAKE_SECRET_PUSH_TOKEN');
const categories = c => c.loader.logs.filter(row => row.args[0] === 'Legacy push request').map(row => row.args[1].category);

describe.each(['check', 'register'])('Actual HTTPApi legacy %s methods', method => {
  test.each([
    [0, true, 'success'], [-1, false, 'backend_nonzero'], [10003, false, 'backend_nonzero'],
    ['0', true, 'malformed_body'], [false, true, 'malformed_body'],
    ['FAKE_SECRET_CODE', false, 'malformed_body'], [undefined, false, 'malformed_body'],
  ])('backend code %s retains baseline boolean and bounded classification', async (code, accepted, category) => {
    const c = apiContext({ body: poisoned(code) });
    expect(await tokenCall(c, method)).toBe(accepted);
    expect(c.requests).toHaveLength(1);
    expect(categories(c)).toEqual(['request_started', 'response_received', category]);
    const row = c.loader.logs.at(-1).args[1];
    expect(row.operation).toBe(method);
    if (typeof code === 'number') expect(row.backendCode).toBe(code); else expect(row.backendCode).toBeUndefined();
    safeLogs(c);
  });
  test('not-connected produces false without cloud call or manufactured backend -1', async () => {
    const c = apiContext({ connected: false }); expect(await tokenCall(c, method)).toBe(false);
    expect(c.requests).toHaveLength(0); expect(categories(c)).toEqual(['not_connected']); safeLogs(c);
  });
  test('returned non-200 is distinct from HTTP200 backend -1 and returns false', async () => {
    const c = apiContext({ status: 503, body: poisoned(-1) }); expect(await tokenCall(c, method)).toBe(false);
    expect(c.requests).toHaveLength(1); expect(categories(c)).toContain('http_non_200');
    expect(categories(c)).not.toContain('backend_nonzero'); safeLogs(c);
  });
  test.each(['RequestError', 'ParseError', 'TimeoutError'])('%s remains false with one request and sanitized error classification', async name => {
    const error = Object.assign(new Error('FAKE_SECRET_ERROR_MESSAGE'), { name, body: poisoned(-1),
      options: { token: 'FAKE_SECRET_OPTIONS_TOKEN' }, cause: new Error('FAKE_SECRET_CAUSE') });
    const c = apiContext({ error }); expect(await tokenCall(c, method)).toBe(false);
    expect(c.requests).toHaveLength(1); expect(categories(c)).toEqual(['request_started', 'transport_error']);
    expect(c.loader.logs.at(-1).args[1].errorClass).toBe(name === 'ParseError' ? 'parse_error' : name === 'TimeoutError' ? 'timeout_error' : 'request_error');
    safeLogs(c);
  });
  test.each([null, undefined])('malformed %s body preserves baseline TypeError rather than changing control flow', async body => {
    const c = apiContext({ body }); await expect(tokenCall(c, method)).rejects.toMatchObject({
      name: 'TypeError', message: `Cannot read properties of ${String(body)} (reading 'code')`,
    });
    expect(c.requests).toHaveLength(1); expect(categories(c)).toContain('malformed_body'); safeLogs(c);
  });
});

describe('Actual HTTPApi request, post wrapper, and hook wiring', () => {
  test('register then check call order and outbound push body remain unchanged', async () => {
    const c = apiContext({ body: poisoned(0) });
    expect(await c.api.registerPushToken('FAKE_SECRET_PUSH_TOKEN')).toBe(true);
    expect(await c.api.checkPushToken()).toBe(true);
    expect(c.requests.map(row => row.endpoint)).toEqual(['v1/apppush/register_push_token', 'v1/app/review/app_push_check']);
    expect(c.requests[0].options).toMatchObject({ method: 'post', responseType: 'json',
      json: { is_notification_enable: true, token: 'FAKE_SECRET_PUSH_TOKEN' } });
    expect(c.requests[1].options.json.app_type).toBe('eufySecurity');
    safeLogs(c);
  });
  test('actual request returns exact response mapping without body/header mutation', async () => {
    const body = poisoned(-1), c = apiContext({ body });
    const response = await c.api.request({ method: 'post', endpoint: c.api.apiPushCheck, data: poisoned(0) });
    expect(response.data).toBe(body); expect(response.status).toBe(200);
    expect(response.headers['X-Auth-Token']).toBe('FAKE_SECRET_RESPONSE_HEADER'); safeLogs(c);
  });
  test('actual makePostRequest forceConnect remains available with one request', async () => {
    const c = apiContext({ connected: false, body: poisoned(0) });
    expect((await c.api.makePostRequest(c.api.apiPushCheck, poisoned(0), true)).data.code).toBe(0);
    expect(c.requests).toHaveLength(1); safeLogs(c);
  });
  test('thrown HTTP error status unwraps through ApiRequestError without logging body or cause', async () => {
    const c = apiContext(); const error = new c.loader.HTTPError('FAKE_SECRET_HTTP_ERROR', {
      statusCode: 503, statusMessage: 'FAKE_SECRET_STATUS', body: poisoned(-1),
    });
    c.api.requestEufyCloud = async () => { c.requests.push({ endpoint: c.api.apiPushCheck }); throw error; };
    expect(await c.api.checkPushToken()).toBe(false); expect(c.requests).toHaveLength(1);
    expect(c.loader.logs.at(-1).args[1]).toMatchObject({ category: 'http_non_200', httpStatus: 503, errorClass: 'http_error' });
    safeLogs(c);
  });
  test('actual loadLibraries retains retry settings and safely wires beforeRetry for poisoned error', async () => {
    const c = apiContext(); await c.api.loadLibraries(); const options = c.loader.gotOptions();
    expect(options.retry.limit).toBe(3); expect(options.retry.methods).toEqual(['GET', 'POST']);
    const error = Object.assign(new Error('FAKE_SECRET_RETRY_MESSAGE'), { name: 'RequestError',
      options: { method: 'POST', url: new URL('https://synthetic.invalid/v1/app/review/app_push_check?secret=FAKE_SECRET_QUERY'),
        prefixUrl: 'https://synthetic.invalid' }, response: { statusCode: 503, body: poisoned(-1) },
      request: { retryCount: 2, requestUrl: 'FAKE_SECRET_REQUEST_URL' }, code: 'FAKE_SECRET_ERROR_CODE' });
    options.hooks.beforeRetry[0](error);
    expect(c.loader.logs.at(-1).args[1]).toMatchObject({ operation: 'check', category: 'http_non_200', httpStatus: 503 });
    safeLogs(c);
  });
  test('actual afterResponse push 401 retains invalidate/login/retry order and emits bounded log', async () => {
    const c = apiContext(); await c.api.loadLibraries(); const options = c.loader.gotOptions(), order = [];
    c.api.invalidateToken = () => { order.push('invalidate'); c.api.token = null; };
    c.api.login = async data => { expect(data).toEqual({ force: true }); order.push('login'); c.api.token = 'FAKE_SECRET_NEW_AUTH'; };
    c.api.requestEufyCloud.defaults.options.merge = data => { order.push('merge'); expect(data.headers['X-Auth-Token']).toBe('FAKE_SECRET_NEW_AUTH'); };
    const response = { statusCode: 401, requestUrl: new URL('https://synthetic.invalid/v1/apppush/register_push_token?token=FAKE_SECRET_QUERY'),
      body: poisoned(-1), statusMessage: 'FAKE_SECRET_STATUS_MESSAGE' };
    const retried = await options.hooks.afterResponse[0](response, async data => { order.push('retry'); return { retried: true }; });
    expect(order).toEqual(['invalidate', 'login', 'merge', 'retry']); expect(retried).toEqual({ retried: true }); safeLogs(c);
  });
  test('actual afterResponse no token change returns original response without extra retry', async () => {
    const c = apiContext(); await c.api.loadLibraries(); const hook = c.loader.gotOptions().hooks.afterResponse[0];
    c.api.invalidateToken = () => { c.api.token = null; }; c.api.login = async () => {};
    const response = { statusCode: 401, requestUrl: 'https://synthetic.invalid/v1/app/review/app_push_check', body: poisoned(-1) };
    const retry = jest.fn(); expect(await hook(response, retry)).toBe(response); expect(retry).not.toHaveBeenCalled(); safeLogs(c);
  });
  test('actual beforeError preserves returned exception semantics and does not itself log secrets', async () => {
    const c = apiContext(); await c.api.loadLibraries();
    const error = Object.assign(new Error('FAKE_SECRET_ORIGINAL'), { response: { statusCode: 503, body: 'FAKE_SECRET_BODY' },
      options: { method: 'POST', url: new URL('https://synthetic.invalid/v1/app/review/app_push_check'), prefixUrl: 'https://synthetic.invalid' } });
    expect(c.loader.gotOptions().hooks.beforeError[0](error)).toBe(error);
    expect(error.name).toBe('EufyApiError'); expect(error.message).toContain('FAKE_SECRET_BODY'); safeLogs(c);
  });
  test('unrelated legacy endpoint keeps original logging and request behavior', async () => {
    const c = apiContext({ body: { code: 0, msg: 'synthetic-safe' } }); c.api.token = 'synthetic-safe-token';
    expect((await c.api.makePostRequest('v1/app/unrelated', { synthetic: true })).status).toBe(200);
    expect(c.requests).toHaveLength(1); expect(c.loader.logs[0].args[0]).toBe('Api request');
    expect(categories(c)).toEqual([]); expect(c.loader.denied).toEqual([]);
  });
});

describe('Actual diagnostic projection module', () => {
  test('unknown classes, nested error strings, and nonfinite fields never become diagnostic values', () => {
    const loader = createLoader(); const { projectPushRequestDiagnostic } = loader.load('http/pushRequestDiagnostics');
    const row = projectPushRequestDiagnostic('FAKE_SECRET_OPERATION', 'FAKE_SECRET_CATEGORY', {
      httpStatus: Infinity, backendCode: 'FAKE_SECRET_CODE', error: { name: 'FAKE_SECRET_NAME', message: 'FAKE_SECRET_MSG', nested: poisoned(-1) },
    });
    expect(row).toEqual({ operation: 'check', category: 'transport_error', errorClass: 'unknown_error' });
  });
  test('projector response classification does not invoke untrusted code/message accessors', () => {
    const loader = createLoader(); const { describePushResponse } = loader.load('http/pushRequestDiagnostics');
    const getter = jest.fn(() => { throw Error('FAKE_SECRET_GETTER'); });
    const body = {}; Object.defineProperty(body, 'code', { get: getter }); Object.defineProperty(body, 'msg', { get: getter });
    expect(describePushResponse('check', 200, body)).toEqual({ operation: 'check', category: 'malformed_body', httpStatus: 200 });
    expect(getter).not.toHaveBeenCalled();
  });
  test('endpoint and URL detection cover exact check/register paths without expanding third-party coverage', () => {
    const loader = createLoader(); const helper = loader.load('http/pushRequestDiagnostics');
    expect(helper.pushOperationFromEndpoint('v1/app/review/app_push_check')).toBe('check');
    expect(helper.pushOperationFromEndpoint('v1/apppush/register_push_token')).toBe('register');
    expect(helper.pushOperationFromUrl(new URL('https://synthetic.invalid/v1/apppush/register_push_token?token=FAKE_SECRET'))).toBe('register');
    expect(helper.pushOperationFromEndpoint('v1/app/other')).toBeUndefined();
    expect(helper.pushOperationFromUrl('FAKE_SECRET_NOT_URL')).toBeUndefined();
  });
});
