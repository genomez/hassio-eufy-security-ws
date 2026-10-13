import {
  classifyRtcNegotiationStage,
  getRtcAppLiveViewTestTiming,
  isNoHubSdpOfferTimeout,
  isRtcAppLiveViewTestEnabled,
  RtcConnectTimeoutError,
  RtcNegotiationDiagnostic,
  shouldRunNoOfferCloudWakeRetry,
  shouldRunRtcAppLiveViewTest,
} from "../rtcSession";

function diagnostic(overrides: Partial<RtcNegotiationDiagnostic> = {}): RtcNegotiationDiagnostic {
  const state = {
    connectionState: "connecting",
    iceConnectionState: "checking",
    iceGatheringState: "new",
    signalingState: "stable",
    selectedPairPresent: false,
    commandChannelOpen: false,
    scallAccepted: false,
    peerInitialized: false,
    sdpHandled: false,
    iceGatheringComplete: false,
    ...overrides,
  };
  return { stage: classifyRtcNegotiationStage(state), ...state };
}

describe("RTC negotiation terminal classification", () => {
  it("classifies scall 100 plus peer init without SDP as a missing hub offer", () => {
    const state = diagnostic({ scallAccepted: true, peerInitialized: true });

    expect(state.stage).toBe("no_hub_sdp_offer");
    expect(isNoHubSdpOfferTimeout(new RtcConnectTimeoutError(state))).toBe(true);
  });

  it("classifies completed SDP without a selected pair as an ICE failure", () => {
    expect(
      diagnostic({
        scallAccepted: true,
        peerInitialized: true,
        sdpHandled: true,
        iceGatheringComplete: true,
      }).stage
    ).toBe("ice_no_selected_pair");
  });

  it("classifies a selected pair without the command channel separately", () => {
    expect(
      diagnostic({
        scallAccepted: true,
        peerInitialized: true,
        sdpHandled: true,
        selectedPairPresent: true,
      }).stage
    ).toBe("command_channel_not_open");
  });

  it("does not classify ordinary or post-SDP timeouts as missing hub offers", () => {
    expect(isNoHubSdpOfferTimeout(new Error("timeout"))).toBe(false);
    expect(isNoHubSdpOfferTimeout(new RtcConnectTimeoutError(diagnostic({ sdpHandled: true })))).toBe(false);
  });

  it("gates the cloud-wake retry behind opt-in, exact classification, and single-attempt state", () => {
    const error = new RtcConnectTimeoutError(diagnostic({ scallAccepted: true, peerInitialized: true }));

    expect(shouldRunNoOfferCloudWakeRetry(error, true, false)).toBe(true);
    expect(shouldRunNoOfferCloudWakeRetry(error, false, false)).toBe(false);
    expect(shouldRunNoOfferCloudWakeRetry(error, true, true)).toBe(false);
    expect(shouldRunNoOfferCloudWakeRetry(new Error("timeout"), true, false)).toBe(false);
  });

  it("gates the app live-view test behind opt-in, exact classification, and single-attempt state", () => {
    const error = new RtcConnectTimeoutError(diagnostic({ scallAccepted: true, peerInitialized: true }));

    expect(isRtcAppLiveViewTestEnabled("1")).toBe(true);
    expect(isRtcAppLiveViewTestEnabled("TRUE")).toBe(true);
    expect(isRtcAppLiveViewTestEnabled("0")).toBe(false);
    expect(shouldRunRtcAppLiveViewTest(error, true, false)).toBe(true);
    expect(shouldRunRtcAppLiveViewTest(error, false, false)).toBe(false);
    expect(shouldRunRtcAppLiveViewTest(error, true, true)).toBe(false);
    expect(shouldRunRtcAppLiveViewTest(new Error("timeout"), true, false)).toBe(false);
  });

  it("uses bounded app live-view timing defaults and overrides", () => {
    expect(getRtcAppLiveViewTestTiming({})).toEqual({
      prepareMs: 60_000,
      activeMs: 30_000,
      settleMs: 15_000,
    });
    expect(getRtcAppLiveViewTestTiming({ prepareMs: "1000", activeMs: "-1", settleMs: "999999" })).toEqual({
      prepareMs: 1000,
      activeMs: 0,
      settleMs: 300_000,
    });
  });
});
