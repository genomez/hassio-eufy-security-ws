#!/usr/bin/env node

const framerModule = process.env.RTC_SCTP_FRAMER_MODULE || "../build/rtc/rtcSctpFramer";
const { RtcSctpFramer } = require(framerModule);

const iterations = Number.parseInt(process.argv[2] || "250", 10);
if (!Number.isSafeInteger(iterations) || iterations < 1) {
  throw new Error("iterations must be a positive integer");
}
if (typeof global.gc !== "function") {
  throw new Error("run with node --expose-gc");
}

async function main() {
  const started = process.memoryUsage();
  let peakRss = started.rss;

  for (let i = 0; i < iterations; i++) {
    let framer = new RtcSctpFramer();
    await framer.init(
      () => {},
      () => {}
    );
    if (!framer.isReady()) {
      throw new Error(`framer ${i + 1} did not become ready`);
    }
    framer.destroy();
    framer = undefined;
    global.gc();
    const current = process.memoryUsage();
    peakRss = Math.max(peakRss, current.rss);
  }

  global.gc();
  const finished = process.memoryUsage();
  process.stdout.write(
    `${JSON.stringify({
      iterations,
      startedRssMiB: Math.round(started.rss / 1024 / 1024),
      peakRssMiB: Math.round(peakRss / 1024 / 1024),
      finishedRssMiB: Math.round(finished.rss / 1024 / 1024),
      finishedExternalMiB: Math.round(finished.external / 1024 / 1024),
    })}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
