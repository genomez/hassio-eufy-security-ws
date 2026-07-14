import { EventEmitter } from "events";
import {
  DataChannel as NdcDataChannel,
  initLogger,
  PeerConnection as NdcPeerConnection,
  type IceServer,
  type PeerConnection,
  type RtcConfig,
} from "node-datachannel";

import { rootHTTPLogger } from "../logging";
import { RtcSctpFramer } from "./rtcSctpFramer";
import { sdpAnswerToScallJson } from "./rtcSdp";

export interface RtcTurnConfig {
  turn_addr: string;
  turn_port: number;
  turn_user: string;
  turn_password: string;
  alt_turn_addr?: string;
  alt_turn_port?: number;
}

export interface RtcPeerOptions {
  iceTransportPolicy?: RTCIceTransportPolicy;
  dtlsSetup?: "active" | "passive";
}

export interface RtcPeerEvents {
  commandChannelOpen: () => void;
  data: (label: string, data: Buffer, linkType?: number) => void;
  iceCandidate: (candidate: string) => void;
  iceGatheringComplete: () => void;
  connectionState: (state: string) => void;
  iceConnectionState: (state: string) => void;
  error: (err: Error) => void;
}

/** Matches security.eufy.com portal channel list (index 0 = command). */
const DATA_CHANNEL_NAMES = ["WebrtcDataChannel", "audio", "idr", "video", "notify", "download"];

/** SCTP stream ids (odd) for multi-channel mode — portal uses id 1 for command only. */
const DATA_CHANNEL_IDS: Record<string, number> = {
  WebrtcDataChannel: 1,
  audio: 3,
  idr: 5,
  video: 7,
  notify: 9,
  download: 11,
};

let ndcLoggerInitialized = false;
// Handshake pacing (see ensureNdcLogger). While > 0, at least one peer is mid-handshake and the
// libdatachannel Debug log callback blocks briefly per message to pace the native ICE/DTLS threads
// — reproducing the timing that lets the T9000 DTLS handshake complete without verbose logging.
let ndcHandshakePacing = 0;
const ndcPacingSab = new Int32Array(new SharedArrayBuffer(4));
function ndcBeginHandshakePacing(): void {
  ndcHandshakePacing++;
}
function ndcEndHandshakePacing(): void {
  if (ndcHandshakePacing > 0) {
    ndcHandshakePacing--;
  }
}

function ensureNdcLogger(): void {
  if (ndcLoggerInitialized) {
    return;
  }
  // The T9000 DTLS handshake is timing-sensitive. libdatachannel runs ICE/DTLS/SCTP on native
  // background threads; the Node main thread must yield often enough for them to be serviced or
  // the DTLS ClientHello/response races ICE pair nomination and the handshake stalls (~31s) then
  // the peer closes. Empirically DTLS completes (~90ms) only when the "Debug" logger callback runs
  // per message, because each callback performs a *synchronous write syscall* that yields the event
  // loop and gives the native threads CPU. A no-op callback does NOT yield and DTLS still stalls.
  //
  // So we always register the Debug logger. When RTC_VERBOSE is on we forward to the add-on log
  // (high volume, for debugging). Otherwise we still perform a cheap synchronous write to /dev/null
  // per message — this reproduces the event-loop yield that stabilizes the handshake without
  // flooding the add-on log.
  const verbose = process.env.RTC_VERBOSE === "1" || process.env.RTC_VERBOSE === "true";
  // Per-message block (ms) applied only during the handshake phase when verbose is off. Emulates
  // the pacing that heavy verbose logging incidentally provided. Tunable via RTC_HANDSHAKE_PACE_MS.
  const paceMs = Math.max(0, Number(process.env.RTC_HANDSHAKE_PACE_MS ?? "0.4") || 0);
  initLogger("Debug", (level, message) => {
    if (verbose) {
      rootHTTPLogger.info("RtcPeer ldc", { level, message });
      return;
    }
    if (paceMs > 0 && ndcHandshakePacing > 0) {
      // Synchronous, non-spinning sleep on a throwaway SharedArrayBuffer — blocks this callback
      // (and thus paces the native thread that emitted the log) without burning CPU.
      Atomics.wait(ndcPacingSab, 0, 0, paceMs);
    }
  });
  ndcLoggerInitialized = true;
}

const ANKER_MAX_MESSAGE_SIZE = 262144;
/** Hub SDP uses BUNDLE mid 2 for the SCTP m-line. */
const HUB_SDP_MID = "2";

function patchAnswerSdp(sdp: string): string {
  return sdp.replace(/a=max-message-size:\d+/g, `a=max-message-size:${ANKER_MAX_MESSAGE_SIZE}`);
}

function iceCandidateSummary(candidate: string): string {
  const typ = candidate.match(/typ (\w+)/)?.[1] ?? "?";
  const addr = candidate.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? candidate.slice(0, 40);
  return `${typ}@${addr}`;
}

function iceCandidateType(candidate: string): string {
  return candidate.match(/typ (\w+)/)?.[1] ?? "unknown";
}

function filterSdpRelayCandidates(sdp: string): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/);
  let stripped = 0;
  const kept = lines.filter((line) => {
    if (!line.startsWith("a=candidate:")) {
      return true;
    }
    if (line.includes(" typ relay ")) {
      return true;
    }
    stripped++;
    return false;
  });
  if (stripped > 0) {
    rootHTTPLogger.info("RtcPeer stripped non-relay candidates from remote SDP", { stripped });
  }
  return kept.join(eol) + (kept.length > 0 && kept[kept.length - 1] !== "" ? eol : "");
}

/** Remove any inline non-host ICE candidate lines from an SDP (host-only mode). */
function stripSdpRelayCandidates(sdp: string): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/);
  let stripped = 0;
  const kept = lines.filter((line) => {
    if (line.startsWith("a=candidate:") && !line.includes(" typ host ")) {
      stripped++;
      return false;
    }
    return true;
  });
  if (stripped > 0) {
    rootHTTPLogger.info("RtcPeer stripped non-host candidates from remote SDP (host-only)", {
      stripped,
    });
  }
  return kept.join(eol) + (kept.length > 0 && kept[kept.length - 1] !== "" ? eol : "");
}

function sdpHighlights(sdp: string): Record<string, string | undefined> {
  const lines = sdp.split(/\r?\n/);
  const pick = (prefix: string): string | undefined => lines.find((l) => l.startsWith(prefix));
  return {
    setup: pick("a=setup:"),
    fingerprint: pick("a=fingerprint:")?.slice(0, 72),
    iceUfrag: pick("a=ice-ufrag:"),
    sctpPort: pick("a=sctp-port:"),
    maxMessageSize: pick("a=max-message-size:"),
  };
}

function turnIceServers(host: string, port: number, user: string, password: string): IceServer[] {
  return [
    {
      hostname: host,
      port,
      username: user,
      password,
      relayType: "TurnUdp",
    },
    {
      hostname: host,
      port,
      username: user,
      password,
      relayType: "TurnTcp",
    },
  ];
}

function mapIceState(state: string): string {
  return state === "completed" ? "connected" : state;
}

function channelNames(): string[] {
  if (process.env.RTC_MINIMAL_DC === "1") {
    return ["WebrtcDataChannel"];
  }
  return DATA_CHANNEL_NAMES;
}

/**
 * WebRTC answerer for T9000 scall sessions (native node-datachannel / libdatachannel).
 * Mirrors portal: createDataChannel(s) → setRemoteDescription(offer) → setLocalDescription(answer).
 */
export class RtcPeerConnection extends EventEmitter {
  private pc?: PeerConnection;
  private dataChannels = new Map<string, NdcDataChannel>();
  private remoteDescriptionSet = false;
  private pendingCandidates: string[] = [];
  private channelsCreated = false;
  private handlingOffer = false;
  private commandChannelOpen = false;
  private snapshotTimer?: NodeJS.Timeout;
  private gatheringCompleteEmitted = false;
  private pacingActive = false;
  private peerOptions: RtcPeerOptions = { iceTransportPolicy: "all", dtlsSetup: "passive" };
  private localRelayCandidateSeen = false;
  private relayCandidateWaiters: Array<() => void> = [];
  private sctpFramer?: RtcSctpFramer;
  private sctpFramerInit?: Promise<void>;
  private localAnswerWaiter?: {
    resolve: (sdp: string) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  };
  private localOfferWaiter?: {
    resolve: (sdp: string) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  };

  public async initWithTurn(turn: RtcTurnConfig, opts?: RtcPeerOptions): Promise<void> {
    ensureNdcLogger();
    if (!this.pacingActive) {
      this.pacingActive = true;
      ndcBeginHandshakePacing();
    }
    if (opts) {
      this.peerOptions = { ...this.peerOptions, ...opts };
    }
    const icePolicy = this.peerOptions.iceTransportPolicy ?? "all";
    rootHTTPLogger.info("RtcPeer initWithTurn", {
      iceTransportPolicy: icePolicy,
      dtlsSetup: this.peerOptions.dtlsSetup,
      api: "native",
      hubRelayMode: icePolicy === "relay",
      skipFpVerify: process.env.RTC_SKIP_FP_VERIFY === "1",
      bindAddress: process.env.RTC_BIND_ADDRESS,
    });

    // The T9000 sits on the LAN and connects over the direct host candidate pair. The Eufy
    // TURN relay never actually completes connectivity, but gathering it takes ~20s to time
    // out and races with / stalls the DTLS handshake on the good host pair. Skip TURN entirely
    // (host-only) unless explicitly re-enabled, so ICE gathering finishes instantly.
    const noTurn = process.env.RTC_NO_TURN === "1" || process.env.RTC_NO_TURN === "true";
    const iceServers: IceServer[] = [];
    if (!noTurn) {
      iceServers.push(
        ...turnIceServers(turn.turn_addr, turn.turn_port, turn.turn_user, turn.turn_password)
      );
      if (turn.alt_turn_addr && turn.alt_turn_port) {
        iceServers.push(
          ...turnIceServers(
            turn.alt_turn_addr,
            turn.alt_turn_port,
            turn.turn_user,
            turn.turn_password
          )
        );
      }
    }

    const rtcConfig: RtcConfig = {
      iceServers,
      iceTransportPolicy: icePolicy,
      maxMessageSize: ANKER_MAX_MESSAGE_SIZE,
      enableIceTcp: true,
    };
    if (process.env.RTC_BIND_ADDRESS) {
      rtcConfig.bindAddress = process.env.RTC_BIND_ADDRESS;
    }
    if (process.env.RTC_SKIP_FP_VERIFY === "1") {
      rtcConfig.disableFingerprintVerification = true;
    }
    this.pc = new NdcPeerConnection("eufy-ha", rtcConfig);

    this.pc.onLocalDescription((sdp, type) => {
      const t = String(type).toLowerCase();
      rootHTTPLogger.info("RtcPeer onLocalDescription", { type: t, len: sdp.length });
      if (t === "answer" && this.localAnswerWaiter) {
        clearTimeout(this.localAnswerWaiter.timer);
        this.localAnswerWaiter.resolve(sdp);
        this.localAnswerWaiter = undefined;
      }
      if (t === "offer" && this.localOfferWaiter) {
        clearTimeout(this.localOfferWaiter.timer);
        this.localOfferWaiter.resolve(sdp);
        this.localOfferWaiter = undefined;
      }
    });

    this.pc.onLocalCandidate((candidate, mid) => {
      if (!candidate) {
        return;
      }
      if (iceCandidateType(candidate) === "relay") {
        this.noteLocalRelayCandidate();
      }
      if (!this.shouldEmitLocalCandidate(candidate)) {
        rootHTTPLogger.info("RtcPeer suppressing local ICE candidate (relay-only signaling)", {
          summary: iceCandidateSummary(candidate),
        });
        return;
      }
      rootHTTPLogger.info("RtcPeer local ICE candidate", {
        summary: iceCandidateSummary(candidate),
        mid,
      });
      this.emit("iceCandidate", candidate);
    });

    this.pc.onGatheringStateChange((state) => {
      rootHTTPLogger.info("RtcPeer iceGatheringState", { state });
      if (state === "complete") {
        this.emitGatheringComplete();
      }
    });

    this.pc.onSignalingStateChange((state) => {
      rootHTTPLogger.info("RtcPeer signalingState", { state });
    });

    this.pc.onStateChange((state) => {
      rootHTTPLogger.info("RtcPeer connectionState", { state });
      this.logSnapshot("connectionState");
      this.emit("connectionState", state);
      if (state === "connected" && !this.commandChannelOpen) {
        this.startSnapshotWatchdog();
      }
      if (state === "connected" || state === "failed" || state === "closed") {
        this.endPacing();
      }
      if (state === "failed" || state === "closed") {
        this.stopSnapshotWatchdog();
      }
    });

    this.pc.onIceStateChange((state) => {
      const mapped = mapIceState(state);
      rootHTTPLogger.info("RtcPeer iceConnectionState", { state: mapped, raw: state });
      this.logSnapshot("iceConnectionState");
      this.emit("iceConnectionState", mapped);
      if (mapped === "connected" && !this.commandChannelOpen) {
        this.startSnapshotWatchdog();
      }
    });

    this.pc.onDataChannel((dc) => {
      rootHTTPLogger.info("RtcPeer inbound dataChannel", {
        label: dc.getLabel(),
        open: dc.isOpen(),
      });
      this.wireDataChannel(dc.getLabel(), dc);
    });
  }

  /**
   * Offerer mode (T9000 2026-07 firmware): create the data channels, which makes
   * libdatachannel auto-generate a local SDP offer. Returns the offer to signal to the hub.
   */
  public async createOffer(): Promise<string> {
    if (!this.pc) {
      throw new Error("RtcPeer not initialized");
    }

    const offerPromise = new Promise<string>((resolve, reject) => {
      const existing = this.pc?.localDescription();
      if (existing?.sdp && String(existing.type).toLowerCase() === "offer") {
        resolve(existing.sdp);
        return;
      }
      const timer = setTimeout(() => {
        this.localOfferWaiter = undefined;
        reject(new Error("Timed out waiting for local SDP offer"));
      }, 15000);
      this.localOfferWaiter = { resolve, reject, timer };
    });

    // Creating the first data channel makes libdatachannel auto-generate the local offer
    // (same mechanism the answerer relies on when setRemoteDescription is called).
    this.createDataChannels();

    const rawOffer = await offerPromise;
    const patched = patchAnswerSdp(rawOffer);
    rootHTTPLogger.info("RtcPeer local SDP offer", sdpHighlights(patched));
    return patched;
  }

  /** Offerer mode: apply the hub's SDP answer and flush any queued remote candidates. */
  public async handleRemoteAnswer(sdpAnswer: string): Promise<void> {
    if (!this.pc) {
      throw new Error("RtcPeer not initialized");
    }
    let answerSdp = sdpAnswer;
    if ((this.peerOptions.iceTransportPolicy ?? "relay") === "relay") {
      answerSdp = filterSdpRelayCandidates(sdpAnswer);
    } else if (process.env.RTC_NO_TURN === "1" || process.env.RTC_NO_TURN === "true") {
      answerSdp = stripSdpRelayCandidates(sdpAnswer);
    }
    // T9000 hub returns "a=setup:actpass" in its answer, which is illegal in an SDP answer
    // (libdatachannel rejects it). Coerce to a concrete DTLS role. Default "passive" makes the
    // hub the DTLS server and us the DTLS client (active) — we initiate the handshake out
    // through TURN, which completes DTLS reliably. Override with RTC_ANSWER_SETUP=active.
    if (/a=setup:actpass/.test(answerSdp)) {
      const answerRole = process.env.RTC_ANSWER_SETUP?.toLowerCase() === "active" ? "active" : "passive";
      answerSdp = answerSdp.replace(/a=setup:actpass/g, `a=setup:${answerRole}`);
      rootHTTPLogger.info("RtcPeer coerced answer DTLS role", { from: "actpass", to: answerRole });
    }
    rootHTTPLogger.info("RtcPeer remote SDP answer", sdpHighlights(answerSdp));
    this.pc.setRemoteDescription(answerSdp, "answer");
    this.remoteDescriptionSet = true;
    rootHTTPLogger.info("RtcPeer setRemoteDescription(answer) ok", {
      signalingState: this.pc.signalingState(),
    });
    try {
      const fp = this.pc.remoteFingerprint();
      rootHTTPLogger.info("RtcPeer remoteFingerprint", {
        algorithm: fp.algorithm,
        value: fp.value?.slice(0, 20),
      });
    } catch {
      /* optional */
    }
    await this.flushPendingCandidates();
    this.startSnapshotWatchdog();
    this.logSnapshot("remoteAnswerApplied");
  }

  public async handleRemoteOffer(sdpOffer: string): Promise<string> {
    if (!this.pc) {
      throw new Error("RtcPeer not initialized");
    }
    if (this.handlingOffer) {
      throw new Error("RtcPeer already handling offer");
    }
    this.handlingOffer = true;

    try {
      this.createDataChannels();

      rootHTTPLogger.info("RtcPeer remote SDP offer", sdpHighlights(sdpOffer));

      let offerSdp = sdpOffer;
      if ((this.peerOptions.iceTransportPolicy ?? "relay") === "relay") {
        offerSdp = filterSdpRelayCandidates(sdpOffer);
      }

      const answerPromise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.localAnswerWaiter = undefined;
          reject(new Error("Timed out waiting for local SDP answer"));
        }, 15000);
        this.localAnswerWaiter = { resolve, reject, timer };
      });

      this.pc.setRemoteDescription(offerSdp, "offer");
      this.remoteDescriptionSet = true;
      rootHTTPLogger.info("RtcPeer setRemoteDescription ok", {
        signalingState: this.pc.signalingState(),
      });
      try {
        const fp = this.pc.remoteFingerprint();
        rootHTTPLogger.info("RtcPeer remoteFingerprint", {
          algorithm: fp.algorithm,
          value: fp.value?.slice(0, 20),
        });
      } catch {
        /* optional */
      }

      let rawSdp = this.pc.localDescription()?.sdp ?? "";
      if (!rawSdp) {
        rawSdp = await answerPromise;
      } else if (this.localAnswerWaiter) {
        clearTimeout(this.localAnswerWaiter.timer);
        this.localAnswerWaiter = undefined;
      }
      rootHTTPLogger.info("RtcPeer native SDP answer", sdpHighlights(rawSdp));

      if ((this.peerOptions.iceTransportPolicy ?? "relay") === "relay") {
        try {
          await this.waitForLocalRelayCandidate();
        } catch (err) {
          rootHTTPLogger.warn("RtcPeer relay candidate wait failed — sending answer anyway", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const patchedSdp = patchAnswerSdp(rawSdp);
      if (patchedSdp !== rawSdp) {
        rootHTTPLogger.info("RtcPeer signaled SDP answer", sdpHighlights(patchedSdp));
      }

      await this.flushPendingCandidates();
      this.startSnapshotWatchdog();
      this.logSnapshot("sdpAnswerSent");

      return patchedSdp;
    } finally {
      this.handlingOffer = false;
    }
  }

  public async addRemoteCandidate(candidate: string): Promise<void> {
    if (!this.pc) {
      return;
    }
    if (!this.shouldAcceptRemoteCandidate(candidate)) {
      rootHTTPLogger.info("RtcPeer ignoring remote ICE candidate (ICE policy filter)", {
        summary: iceCandidateSummary(candidate),
        iceTransportPolicy: this.peerOptions.iceTransportPolicy,
      });
      return;
    }
    if (!this.remoteDescriptionSet || this.handlingOffer) {
      this.pendingCandidates.push(candidate);
      return;
    }
    this.addCandidateNow(candidate);
  }

  public isCommandChannelReady(): boolean {
    const dc = this.dataChannels.get("WebrtcDataChannel");
    return this.commandChannelOpen && !!dc?.isOpen();
  }

  public sendCommand(data: Buffer): boolean {
    const dc = this.dataChannels.get("WebrtcDataChannel");
    if (!dc || !dc.isOpen() || !this.commandChannelOpen) {
      rootHTTPLogger.debug("RtcPeer sendCommand skipped — WebrtcDataChannel not open");
      return false;
    }
    if (this.sctpFramer?.isReady()) {
      this.sctpFramer.sendFrame(data);
      return true;
    }
    rootHTTPLogger.warn("RtcPeer sendCommand without SCTP framer — sending raw portal packet");
    dc.sendMessageBinary(data);
    return true;
  }

  public getCommandChannelScallJson(sdp: string): string {
    const json = sdpAnswerToScallJson(sdp);
    const setupOverride = process.env.RTC_SIGNAL_SETUP?.toLowerCase();
    if (setupOverride === "passive" || setupOverride === "active") {
      json.setup = setupOverride;
    }
    return JSON.stringify(json);
  }

  public getLocalAnswerSdp(): string | undefined {
    const raw = this.pc?.localDescription()?.sdp;
    if (!raw) {
      return undefined;
    }
    return patchAnswerSdp(raw);
  }

  public waitForIceGatheringComplete(timeoutMs = 15000): Promise<void> {
    if (this.gatheringCompleteEmitted || this.pc?.gatheringState() === "complete") {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("iceGatheringComplete", onComplete);
        reject(new Error("Timed out waiting for ICE gathering complete"));
      }, timeoutMs);
      const onComplete = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once("iceGatheringComplete", onComplete);
    });
  }

  public close(): void {
    this.stopSnapshotWatchdog();
    this.sctpFramer?.destroy();
    this.sctpFramer = undefined;
    this.sctpFramerInit = undefined;
    if (this.localAnswerWaiter) {
      clearTimeout(this.localAnswerWaiter.timer);
      this.localAnswerWaiter = undefined;
    }
    if (this.localOfferWaiter) {
      clearTimeout(this.localOfferWaiter.timer);
      this.localOfferWaiter = undefined;
    }
    this.commandChannelOpen = false;
    this.gatheringCompleteEmitted = false;
    this.localRelayCandidateSeen = false;
    this.relayCandidateWaiters = [];
    this.endPacing();
    this.pc?.close();
    this.pc = undefined;
    this.dataChannels.clear();
    this.channelsCreated = false;
    this.remoteDescriptionSet = false;
    this.pendingCandidates = [];
  }

  /** Release this peer's handshake-pacing hold on the shared libdatachannel log callback. */
  private endPacing(): void {
    if (this.pacingActive) {
      this.pacingActive = false;
      ndcEndHandshakePacing();
    }
  }

  private createDataChannels(): void {
    if (!this.pc || this.channelsCreated) {
      return;
    }
    this.channelsCreated = true;

    if (process.env.RTC_INBOUND_DC_ONLY === "1") {
      rootHTTPLogger.info("RtcPeer inbound-only dataChannel mode — waiting for hub");
      return;
    }

    for (const name of channelNames()) {
      const id = DATA_CHANNEL_IDS[name];
      const config = id !== undefined ? { id, unordered: false } : { unordered: false };
      const dc = this.pc.createDataChannel(name, config);
      rootHTTPLogger.info("RtcPeer createDataChannel", {
        label: name,
        open: dc.isOpen(),
      });
      this.wireDataChannel(name, dc);
    }
  }

  private wireDataChannel(name: string, dc: NdcDataChannel): void {
    if (this.dataChannels.has(name)) {
      return;
    }
    rootHTTPLogger.info("RtcPeer wireDataChannel", { label: name, open: dc.isOpen() });

    dc.onOpen(() => {
      rootHTTPLogger.info("RtcPeer dataChannel open", { label: name });
      if (name === "WebrtcDataChannel") {
        void this.initSctpFramer(dc)
          .then(() => {
            this.commandChannelOpen = true;
            this.stopSnapshotWatchdog();
            this.logSnapshot("commandChannelOpen");
            this.emit("commandChannelOpen");
          })
          .catch((err) => {
            rootHTTPLogger.error("RtcPeer command channel SCTP setup failed", {
              error: err instanceof Error ? err.message : String(err),
            });
            this.emit("error", err instanceof Error ? err : new Error(String(err)));
          });
      }
    });
    dc.onClosed(() => {
      rootHTTPLogger.info("RtcPeer dataChannel close", { label: name });
      if (name === "WebrtcDataChannel") {
        this.commandChannelOpen = false;
      }
    });
    dc.onError((err) => {
      rootHTTPLogger.warn("RtcPeer dataChannel error", { label: name, error: err });
      this.emit("error", new Error(`RtcPeer dataChannel error: ${name}: ${err}`));
    });
    dc.onMessage((msg) => {
      const buf =
        typeof msg === "string"
          ? Buffer.from(msg)
          : Buffer.isBuffer(msg)
            ? msg
            : Buffer.from(msg as ArrayBuffer);
      if (name === "WebrtcDataChannel" && this.sctpFramer?.isReady()) {
        this.sctpFramer.recvPacket(buf);
        return;
      }
      if (name === "notify" && this.sctpFramer?.isReady()) {
        this.sctpFramer.recvPacket(buf);
        return;
      }
      if (name === "download" && this.sctpFramer?.isReady()) {
        this.sctpFramer.recvPacket(buf);
        return;
      }
      this.emit("data", name, buf);
    });
    this.dataChannels.set(name, dc);
  }

  private initSctpFramer(dc: NdcDataChannel): Promise<void> {
    if (this.sctpFramerInit) {
      return this.sctpFramerInit;
    }
    const framer = new RtcSctpFramer();
    this.sctpFramer = framer;
    this.sctpFramerInit = framer
      .init(
        (wirePacket) => {
          if (!dc.isOpen()) {
            rootHTTPLogger.warn("RtcPeer SCTP wire send skipped — channel closed");
            return;
          }
          if (process.env.RTC_VERBOSE === "1" || process.env.RTC_VERBOSE === "true") {
            rootHTTPLogger.info("RtcPeer SCTP wire send", {
              bytes: wirePacket.length,
              prefix: wirePacket.subarray(0, Math.min(16, wirePacket.length)).toString("hex"),
            });
          }
          dc.sendMessageBinary(wirePacket);
        },
        (frame, linkType) => {
          if (process.env.RTC_VERBOSE === "1" || process.env.RTC_VERBOSE === "true") {
            rootHTTPLogger.info("RtcPeer SCTP frame recv", {
              linkType,
              bytes: frame.length,
              prefix: frame.subarray(0, Math.min(16, frame.length)).toString("hex"),
            });
          }
          this.emit("data", "WebrtcDataChannel", frame, linkType);
        }
      )
      .catch((err) => {
        this.sctpFramer = undefined;
        this.sctpFramerInit = undefined;
        throw err;
      });
    return this.sctpFramerInit;
  }

  private logSnapshot(reason: string): void {
    if (!this.pc) {
      return;
    }
    const pair = this.pc.getSelectedCandidatePair();
    const dataChannels = Object.fromEntries(
      [...this.dataChannels.entries()].map(([label, dc]) => [label, dc.isOpen() ? "open" : "connecting"])
    );
    rootHTTPLogger.info("RtcPeer snapshot", {
      reason,
      connectionState: this.pc.state(),
      iceConnectionState: mapIceState(this.pc.iceState()),
      iceGatheringState: this.pc.gatheringState(),
      signalingState: this.pc.signalingState(),
      selectedPair: pair
        ? {
            local: `${pair.local.type} ${pair.local.address}:${pair.local.port}`,
            remote: `${pair.remote.type} ${pair.remote.address}:${pair.remote.port}`,
          }
        : null,
      dataChannels,
      pendingCandidates: this.pendingCandidates.length,
      commandChannelOpen: this.commandChannelOpen,
    });
  }

  private startSnapshotWatchdog(): void {
    if (this.snapshotTimer || this.commandChannelOpen) {
      return;
    }
    this.snapshotTimer = setInterval(() => {
      if (this.commandChannelOpen || !this.pc) {
        this.stopSnapshotWatchdog();
        return;
      }
      this.logSnapshot("watchdog");
    }, 5000);
  }

  private stopSnapshotWatchdog(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = undefined;
    }
  }

  private addCandidateNow(candidate: string): void {
    if (!this.pc) {
      return;
    }
    try {
      this.pc.addRemoteCandidate(candidate, HUB_SDP_MID);
      rootHTTPLogger.info("RtcPeer remote ICE candidate added", {
        summary: iceCandidateSummary(candidate),
      });
    } catch (err) {
      rootHTTPLogger.warn("RtcPeer addIceCandidate failed", {
        candidate: candidate.slice(0, 60),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private emitGatheringComplete(): void {
    if (this.gatheringCompleteEmitted) {
      return;
    }
    this.gatheringCompleteEmitted = true;
    rootHTTPLogger.info("RtcPeer ICE gathering complete");
    this.emit("iceGatheringComplete");
  }

  private noteLocalRelayCandidate(): void {
    if (this.localRelayCandidateSeen) {
      return;
    }
    this.localRelayCandidateSeen = true;
    rootHTTPLogger.info("RtcPeer local relay candidate ready");
    for (const wake of this.relayCandidateWaiters) {
      wake();
    }
    this.relayCandidateWaiters = [];
  }

  private waitForLocalRelayCandidate(timeoutMs = 20000): Promise<void> {
    if (this.localRelayCandidateSeen) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for local TURN relay candidate"));
      }, timeoutMs);
      this.relayCandidateWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private shouldEmitLocalCandidate(candidate: string): boolean {
    if ((this.peerOptions.iceTransportPolicy ?? "relay") !== "relay") {
      return true;
    }
    return iceCandidateType(candidate) === "relay";
  }

  private shouldAcceptRemoteCandidate(candidate: string): boolean {
    if ((this.peerOptions.iceTransportPolicy ?? "relay") === "relay") {
      return iceCandidateType(candidate) === "relay";
    }
    // Host-only mode (RTC_NO_TURN): accept ONLY host-type remote candidates. Both devices are on
    // the LAN, so the direct host pair (e.g. 192.168.50.x) is the only path that actually carries
    // DTLS/SCTP. The hub also offers a TURN relay candidate and a server-reflexive (srflx) public
    // candidate; both can pass STUN connectivity checks (so ICE may *nominate* them) yet neither
    // completes the DTLS handshake — if one wins the nomination race the ClientHello is black-holed
    // and the handshake stalls ~31s then drops. Restricting to host candidates removes that race so
    // ICE deterministically settles on the working direct LAN pair.
    const noTurn = process.env.RTC_NO_TURN === "1" || process.env.RTC_NO_TURN === "true";
    if (noTurn && iceCandidateType(candidate) !== "host") {
      return false;
    }
    return true;
  }

  private async flushPendingCandidates(): Promise<void> {
    const pending = this.pendingCandidates.filter((c) => this.shouldAcceptRemoteCandidate(c));
    this.pendingCandidates = [];
    for (const c of pending) {
      this.addCandidateNow(c);
    }
  }
}
