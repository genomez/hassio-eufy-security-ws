# Hosted compiled coordination fixtures

These copied fixtures contain 82 candidate cases: 40 coordination, 40 safe
diagnostic classifications and two semantic controls. The reviewed source
fixture inputs remain in the candidate fixture directory; this copy adapts only
loader/configuration paths and hosted qualification documentation.

The hosted loader requires SUBJECT_COMPILED_ROOT=/usr/src/app/client/build and
FIXTURE_TOOLCHAIN_ROOT=/usr/src/app/client/node_modules. It reads installed
compiled CommonJS product files directly. It cannot transpile product source.
Jest transforms only fixture TypeScript and writes its cache beneath
FIXTURE_CACHE_ROOT=/data/jest-cache.

The outer packaged runner mounts fixtures read-only, uses network none, enables
the strict network/native/subprocess guard, and enables experimental VM modules
for synthetic dynamic imports. VM dependencies are explicitly admitted; unlisted
imports fail closed. The fixed receipt is PACKAGED_STARTUP_COORDINATION.json,
with 82 cases, no forced termination, zero denied operations and the exact tested
image identity.

The receipt hashes the required sixteen-module union and claims execution of
actual compiled SDK modules. It reports actualCompiledWebSocket: false; the
preserved push fixture covers compiled WebSocket execution separately.

static-check.cjs parses fixture syntax and counts declared cases only. Its output
cannot establish a passing runtime qualification. No real authentication,
hardware, notification delivery or production access is tested here.
