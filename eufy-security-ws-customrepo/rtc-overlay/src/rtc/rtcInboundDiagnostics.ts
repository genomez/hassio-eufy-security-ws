/** Ring buffer of recent RTC inbound events for poll-miss / stale-session diagnosis. */

export type RtcInboundDiagKind =
  | "pending_match"
  | "db_latest"
  | "db_parse_fail"
  | "ping_ack"
  | "cmd_ack"
  | "unmatched"
  | "unhandled_portal"
  | "raw_json"
  | "notify";

export interface RtcInboundDiagEntry {
  kind: RtcInboundDiagKind;
  linkType?: number;
  commandID?: number;
  errCode?: number;
  bytes?: number;
  detail?: string;
}

export interface RtcInboundDiagEvent extends RtcInboundDiagEntry {
  at: number;
  ageMs: number;
}

export interface RtcInboundDiagnosticsSnapshot {
  sessionStartedAt: number;
  sessionUptimeMs: number;
  inboundIdleMs: number;
  lastInboundAt: number;
  counts: Record<RtcInboundDiagKind, number>;
  recent: RtcInboundDiagEvent[];
}

const KINDS: RtcInboundDiagKind[] = [
  "pending_match",
  "db_latest",
  "db_parse_fail",
  "ping_ack",
  "cmd_ack",
  "unmatched",
  "unhandled_portal",
  "raw_json",
  "notify",
];

function emptyCounts(): Record<RtcInboundDiagKind, number> {
  return Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<RtcInboundDiagKind, number>;
}

export class RtcInboundDiagnostics {
  private sessionStartedAt = 0;
  private lastInboundAt = 0;
  private readonly events: Array<RtcInboundDiagEntry & { at: number }> = [];
  private readonly counts = emptyCounts();
  private readonly maxEvents: number;

  constructor(maxEvents = 24) {
    this.maxEvents = maxEvents;
  }

  reset(): void {
    this.sessionStartedAt = Date.now();
    this.lastInboundAt = 0;
    this.events.length = 0;
    Object.assign(this.counts, emptyCounts());
  }

  noteInbound(at = Date.now()): void {
    this.lastInboundAt = at;
  }

  record(entry: RtcInboundDiagEntry, at = Date.now()): void {
    this.lastInboundAt = at;
    this.counts[entry.kind]++;
    this.events.push({ ...entry, at });
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  snapshot(now = Date.now()): RtcInboundDiagnosticsSnapshot {
    const inboundIdleMs = this.lastInboundAt === 0 ? Number.POSITIVE_INFINITY : now - this.lastInboundAt;
    return {
      sessionStartedAt: this.sessionStartedAt,
      sessionUptimeMs: this.sessionStartedAt === 0 ? 0 : now - this.sessionStartedAt,
      inboundIdleMs,
      lastInboundAt: this.lastInboundAt,
      counts: { ...this.counts },
      recent: this.events.map((e) => ({
        ...e,
        ageMs: now - e.at,
      })),
    };
  }
}
