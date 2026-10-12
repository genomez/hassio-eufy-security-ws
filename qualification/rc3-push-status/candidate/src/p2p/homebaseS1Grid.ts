/**
 * T9000 HomeBase Professional S1 grid updates (CMD_NOTIFY_PAYLOAD inner cmd 9243).
 * The station pushes a dev_list with per-device cur_video_state values.
 */

export interface HomeBaseS1GridDevice {
  ch?: number;
  sn?: string;
  cur_video_state?: number;
  dev_type?: number;
  name?: string;
  status?: number;
}

export interface HomeBaseS1GridNotifyPayload {
  sn?: string;
  name?: string;
  dev_list?: HomeBaseS1GridDevice[];
}

export type HomeBaseS1VideoMotionEvent = "start" | "end" | "none";

/**
 * P2P grid motion is experimental — disabled until 6↔4 recording toggles are handled cleanly.
 * Set true to re-enable T9000 cur_video_state motion for testing.
 */
export const HOME_BASE_S1_GRID_MOTION_ENABLED = false;

/** T9000 cur_video_state 4 = recording / motion clip in progress. */
export function isHomeBaseS1RecordingState(state: number): boolean {
  return state === 4;
}

/**
 * Derive a motion start/end from cur_video_state transitions.
 *
 * Observed on T9000: 0 = idle, 2 = live/preview (not motion), 4 = recording/event.
 * Only state 4 is treated as motion — avoids false ends from 2↔0 grid heartbeats.
 */
export function getHomeBaseS1VideoMotionEvent(
  previousState: number | undefined,
  currentState: number
): HomeBaseS1VideoMotionEvent {
  if (previousState === undefined || previousState === currentState) {
    return "none";
  }
  if (isHomeBaseS1RecordingState(currentState) && !isHomeBaseS1RecordingState(previousState)) {
    return "start";
  }
  if (isHomeBaseS1RecordingState(previousState) && !isHomeBaseS1RecordingState(currentState)) {
    return "end";
  }
  return "none";
}

export function extractGridDeviceVideoStates(
  payload: HomeBaseS1GridNotifyPayload
): Array<{ sn: string; channel: number; curVideoState: number }> {
  const devList = payload?.dev_list;
  if (!Array.isArray(devList)) {
    return [];
  }
  const states: Array<{ sn: string; channel: number; curVideoState: number }> = [];
  for (const device of devList) {
    if (device.sn && typeof device.cur_video_state === "number") {
      states.push({
        sn: device.sn,
        channel: device.ch ?? 0,
        curVideoState: device.cur_video_state,
      });
    }
  }
  return states;
}

/**
 * Suppress repeated start events while a clip is active (T9000 grid toggles e.g. 6↔4 during one recording).
 */
export function applyHomeBaseS1MotionLatch(
  motionActive: Map<string, boolean>,
  deviceSn: string,
  motionEvent: HomeBaseS1VideoMotionEvent
): HomeBaseS1VideoMotionEvent {
  if (motionEvent === "none") {
    return "none";
  }
  if (motionEvent === "start") {
    if (motionActive.get(deviceSn)) {
      return "none";
    }
    motionActive.set(deviceSn, true);
    return "start";
  }
  motionActive.set(deviceSn, false);
  return "end";
}
