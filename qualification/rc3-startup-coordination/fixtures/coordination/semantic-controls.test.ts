// @ts-nocheck
const { stationContext, apiContext } = require('./contexts.cjs');
// These assert candidate behavior using methods that exist in the immutable .3 source.
// A .3 run must fail assertions below, rather than fail on an absent helper import.
describe('Baseline semantic controls', () => {
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
  test('actual Station duplicate startup producer sends collapse after fast ACK', () => {
    jest.useFakeTimers(); const c = stationContext();
    c.station.getCameraInfo('startup-catchup', 0); c.ack(c.sent[0]);
    c.station.getCameraInfo('startup-sdk', 0); c.station.getCameraInfo('startup-floodlight', 0);
    expect(c.sent).toHaveLength(1);
  });
  test('actual legacy request logs omit fake token/body/header secrets', async () => {
    const c = apiContext({ body: { code: -1, msg: 'FAKE_SECRET_BACKEND_MSG', data: { token: 'FAKE_SECRET_NESTED' } } });
    expect(await c.api.registerPushToken('FAKE_SECRET_PUSH_TOKEN')).toBe(false);
    expect(c.requests).toHaveLength(1);
    expect(JSON.stringify(c.loader.logs)).not.toContain('FAKE_SECRET');
  });
});
