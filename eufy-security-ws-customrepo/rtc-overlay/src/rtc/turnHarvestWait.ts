import { RtcTurnConfig } from "./rtcPeer";

export interface TurnHarvestSession {
  connect(): Promise<void>;
  once(event: "turn", listener: (turn: RtcTurnConfig) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "turn", listener: (turn: RtcTurnConfig) => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
}

/**
 * Start an RTC signaling session and wait for its TURN configuration.
 *
 * The connection attempt and timeout share one observed promise so an early
 * connect failure cannot leave a timer-backed promise to reject unhandled.
 */
export function connectAndWaitForTurn(session: TurnHarvestSession, timeoutMs: number): Promise<RtcTurnConfig> {
  return new Promise<RtcTurnConfig>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      session.removeListener("turn", onTurn);
      session.removeListener("error", onError);
    };
    const onTurn = (turn: RtcTurnConfig): void => {
      cleanup();
      resolve(turn);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    session.once("turn", onTurn);
    session.once("error", onError);
    timer = setTimeout(() => onError(new Error("turn harvest timeout")), timeoutMs);

    void Promise.resolve()
      .then(() => session.connect())
      .catch((error: unknown) => onError(error instanceof Error ? error : new Error(String(error))));
  });
}
