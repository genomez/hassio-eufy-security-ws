import { createHash } from "crypto";
import { EventEmitter } from "events";

import { rootHTTPLogger } from "../logging";
import { RtcSession } from "./rtcSession";
import { MegaRtcCredentials } from "./types";

export interface StationRtcTransportEvents {
  connected: () => void;
  close: () => void;
  error: (err: Error) => void;
}

/**
 * T9000 WebRTC transport — sign → WS auth → scall → data channel.
 * Replaces legacy TUTK P2P for HomeBase Professional S1.
 */
export class StationRtcTransport extends EventEmitter {
  private session?: RtcSession;
  private connecting = false;
  private connected = false;
  private commandDataHandler?: (data: Buffer, linkType?: number) => void;

  constructor(
    private readonly stationSn: string,
    private readonly adminUserId: string,
    private credentials: MegaRtcCredentials,
    private readonly connectTimeoutMs = 180000
  ) {
    super();
  }

  public updateCredentials(credentials: MegaRtcCredentials): void {
    this.credentials = credentials;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public isConnecting(): boolean {
    return this.connecting;
  }

  public async connect(): Promise<void> {
    if (this.connected || this.connecting) {
      return;
    }
    if (!this.credentials.authToken || !this.credentials.userId) {
      throw new Error("T9000 RTC: mega credentials missing");
    }

    this.connecting = true;
    const gtoken = createHash("md5").update(this.credentials.userId).digest("hex");

    this.session = new RtcSession({
      authToken: this.credentials.authToken,
      gtoken,
      stationSn: this.stationSn,
      adminUserId: this.adminUserId,
      region: this.credentials.region,
    });

    this.session.on("connected", () => {
      if (this.connected) {
        return;
      }
      this.connecting = false;
      this.connected = true;
      this.emit("connected");
    });
    this.session.on("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.connecting = false;
      if (wasConnected) {
        this.emit("close");
      }
    });
    this.session.on("error", (err) => this.emit("error", err));
    this.session.on("commandData", (data, linkType) => {
      this.commandDataHandler?.(data, linkType);
    });

    rootHTTPLogger.info("StationRtcTransport connecting", { stationSn: this.stationSn });

    try {
      await this.session.connect();
    } catch (err) {
      this.connecting = false;
      this.closeSession();
      throw err;
    }

    if (this.connected) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.connecting = false;
        this.closeSession();
        reject(new Error("T9000 RTC connect timeout"));
      }, this.connectTimeoutMs);

      const onConnected = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        this.connecting = false;
        this.closeSession();
        reject(err);
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        this.off("connected", onConnected);
        this.off("error", onError);
      };

      this.on("connected", onConnected);
      this.on("error", onError);
    });
  }

  public isCommandChannelReady(): boolean {
    return this.session?.isCommandChannelReady() ?? false;
  }

  public sendCommand(data: Buffer): boolean {
    return this.session?.sendCommand(data) ?? false;
  }

  public onCommandData(handler: (data: Buffer, linkType?: number) => void): void {
    this.commandDataHandler = handler;
  }

  public close(): void {
    this.connecting = false;
    this.connected = false;
    this.closeSession();
  }

  private closeSession(): void {
    if (this.session) {
      try {
        this.session.close();
      } catch {
        /* ignore */
      }
      this.session = undefined;
    }
  }
}
