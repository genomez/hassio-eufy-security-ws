import {
  applyHomeBaseS1MotionLatch,
  extractGridDeviceVideoStates,
  getHomeBaseS1VideoMotionEvent,
  HomeBaseS1GridNotifyPayload,
} from "../homebaseS1Grid";

describe("HomeBase S1 grid motion", () => {
  describe("getHomeBaseS1VideoMotionEvent", () => {
    it("returns none on first sighting (baseline only)", () => {
      expect(getHomeBaseS1VideoMotionEvent(undefined, 0)).toBe("none");
      expect(getHomeBaseS1VideoMotionEvent(undefined, 2)).toBe("none");
      expect(getHomeBaseS1VideoMotionEvent(undefined, 4)).toBe("none");
    });

    it("returns none when state is unchanged", () => {
      expect(getHomeBaseS1VideoMotionEvent(2, 2)).toBe("none");
    });

    it("detects recording start at state 4", () => {
      expect(getHomeBaseS1VideoMotionEvent(0, 4)).toBe("start");
      expect(getHomeBaseS1VideoMotionEvent(2, 4)).toBe("start");
    });

    it("detects recording end only when leaving state 4", () => {
      expect(getHomeBaseS1VideoMotionEvent(4, 0)).toBe("end");
      expect(getHomeBaseS1VideoMotionEvent(4, 2)).toBe("end");
    });

    it("ignores preview heartbeat transitions (2 to 0)", () => {
      expect(getHomeBaseS1VideoMotionEvent(2, 0)).toBe("none");
      expect(getHomeBaseS1VideoMotionEvent(0, 2)).toBe("none");
    });

    it("ignores non-recording active states", () => {
      expect(getHomeBaseS1VideoMotionEvent(0, 1)).toBe("none");
      expect(getHomeBaseS1VideoMotionEvent(0, 3)).toBe("none");
      expect(getHomeBaseS1VideoMotionEvent(6, 4)).toBe("start");
    });
  });

  describe("applyHomeBaseS1MotionLatch", () => {
    it("allows only one start until end", () => {
      const latch = new Map<string, boolean>();
      const sn = "T8425T2123391972";
      expect(applyHomeBaseS1MotionLatch(latch, sn, "start")).toBe("start");
      expect(applyHomeBaseS1MotionLatch(latch, sn, "start")).toBe("none");
      expect(applyHomeBaseS1MotionLatch(latch, sn, "end")).toBe("end");
      expect(applyHomeBaseS1MotionLatch(latch, sn, "start")).toBe("start");
    });
  });

  describe("extractGridDeviceVideoStates", () => {
    it("extracts device serial numbers and video states", () => {
      const payload: HomeBaseS1GridNotifyPayload = {
        dev_list: [
          { ch: 4, sn: "T8425T2123391972", cur_video_state: 4 },
          { ch: 6, sn: "T821451023401215", cur_video_state: 0 },
          { sn: "ignored" },
        ],
      };
      expect(extractGridDeviceVideoStates(payload)).toEqual([
        { sn: "T8425T2123391972", channel: 4, curVideoState: 4 },
        { sn: "T821451023401215", channel: 6, curVideoState: 0 },
      ]);
    });

    it("returns empty array for missing dev_list", () => {
      expect(extractGridDeviceVideoStates({})).toEqual([]);
    });
  });
});
