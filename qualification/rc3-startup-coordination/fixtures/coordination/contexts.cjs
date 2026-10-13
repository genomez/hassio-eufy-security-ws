'use strict';
const { createLoader } = require('./module-loader.cjs');
function stationContext(options = {}) {
  const loader = createLoader(options);
  const { Station } = loader.load('http/station');
  const { CommandType, ErrorCode } = loader.load('p2p/types');
  const station = Object.create(Station.prototype);
  const sent = [], cancelled = [], observed = new Map(), events = [];
  let ready = options.ready !== false, connected = options.connected !== false;
  Object.assign(station, {
    rtcCameraInfoTokens: new WeakMap(), rtcCameraInfoRequests: new Map(),
    rtcCatchupTimers: [], properties: {}, rawProperties: {}, rtcPollMisses: 0,
    terminating: false, rawStation: { station_sn: 'synthetic-station', member: { admin_user_id: 'synthetic-account' } },
    getSerial: () => 'synthetic-station', isStationHomeBaseProfessionalS1: () => options.s1 !== false,
    isConnected: () => connected, isEnergySavingDevice: () => false,
    rtcTransport: { isConnected: () => connected, isCommandChannelReady: () => ready, close: () => {}, isConnecting: () => false },
    emit: (...args) => { events.push(args); }, acknowledgeRtcPollResponse: () => {},
    hasCommand: () => false, syncCurrentModeFromGuardModeIfNeeded: () => {},
    p2pSession: {
      observeRtcCameraInfoSend: (data, callback) => observed.set(data, callback),
      sendCommandWithInt: (command, data) => {
        if (options.sendError) throw new Error('synthetic send failure');
        sent.push({ command, data });
        if (options.autoSend !== false && data) { const callback = observed.get(data); observed.delete(data); callback?.(12000); }
      },
      cancelQueuedRtcCameraInfo: data => { cancelled.push(data); observed.delete(data); },
      setRtcCommandTransport: () => {}, close: () => {}, isConnected: () => connected,
    },
  });
  // Keep disconnect side effects in memory; actual reset/release implementation still runs.
  for (const method of ['clearRtcCatchupTimers', 'stopRtcLivePoll', 'stopRtcPropertyRefresh',
    'clearProactiveRtcReconnect', 'cancelActiveRtcHandoff', 'clearRtcPollWatchdog',
    'scheduleRtcReconnect', 'scheduleReconnect', 'clearReconnectTimeout', 'clearRtcHandoffDeadline', 'cancelRtcAppLiveViewTest']) {
    station[method] = () => {};
  }
  return { loader, Station, station, sent, cancelled, observed, events, CommandType, ErrorCode,
    setReady: value => { ready = value; }, setConnected: value => { connected = value; },
    ack: (row, code = 0) => station.onCommandResponse({ command_type: CommandType.CMD_CAMERA_INFO,
      channel: Station.CHANNEL, return_code: code, customData: row.data }),
    markSent: (row, timeout = 12000) => { const callback = observed.get(row.data); observed.delete(row.data); callback?.(timeout); },
  };
}
function apiContext(options = {}) {
  const loader = createLoader(options);
  const { HTTPApi } = loader.load('http/api');
  const api = Object.create(HTTPApi.prototype);
  const requests = [], events = [];
  Object.assign(api, {
    connected: options.connected !== false, token: 'FAKE_SECRET_AUTH_TOKEN', tokenExpiration: new Date(9999999999999),
    apiPushCheck: 'v1/app/review/app_push_check', apiRegisterPushToken: 'v1/apppush/register_push_token',
    headers: { 'X-Auth-Token': 'FAKE_SECRET_HEADER' }, apiBase: 'https://synthetic.invalid',
    throttle: fn => fn, emit: (...args) => { events.push(args); },
    requestEufyCloud: async (endpoint, transportOptions) => {
      requests.push({ endpoint, options: transportOptions });
      if (options.error) throw options.error;
      return { statusCode: options.status ?? 200, statusMessage: 'FAKE_SECRET_STATUS_MESSAGE',
        headers: { 'X-Auth-Token': 'FAKE_SECRET_RESPONSE_HEADER' },
        body: Object.prototype.hasOwnProperty.call(options, 'body') ? options.body : { code: 0 } };
    },
  });
  return { loader, HTTPApi, api, requests, events };
}
module.exports = { stationContext, apiContext };
