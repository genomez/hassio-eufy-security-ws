# Default-entrypoint startup qualification

These fixtures are for the separately approved disposable GitHub-hosted Linux
runner only. Do not execute Docker locally or on Home Assistant. They do not
publish an image or authorize another reporter start.

Run `python3 fixtures/qualify.py --original <fixed-public-digest-reference>
--candidate <local-corrected-image> --output startup-results.json` after deriving the corrected image from the fixed
public immutable original. The runner must independently verify image metadata
and identical root filesystem layers before these checks.

Every test uses its image's original default process with no command or
entrypoint override. The original is expected to fail with envdir exit111. The
corrected empty options case must reach the launcher's existing missing-option
message and never launch Node. The synthetic case runs genuine /init,
with-contenv, Bashio, the unchanged /run.sh and installed Node CLI. NODE_OPTIONS
adds a qualification boundary preload, replacing only EufySecurity.initialize
with a synthetic EventEmitter driver. The installed launcher SHA256, configuration,
RTC defaults, listening,
readiness and graceful stop are checked without hardware or real auth.

Containers have network mode none, no published ports, a read-only fixture mount,
and fresh temporary /data containing synthetic options only. No host secret or
authentication environment, Docker socket, Supervisor API, privileged mode,
host PID or host network is passed into a container. The Node boundary blocks
outbound HTTP/TLS/DNS/sockets/datagrams/fetch, workers and subprocesses. Only the
unchanged CLI's literal local 0.0.0.0:3000 listener is allowed. DNS lookup of that
literal bind address is answered locally without invoking a resolver.

Docker stop sends SIGTERM to genuine init and uses timeout -1, preventing fallback
SIGKILL. A failed running container is never forcibly removed. Receipts include
only fixed diagnostic markers, process paths/args, canonical tested-container image
IDs and public image references;
raw container logs and generated synthetic options stay out of output.

Passing these checks establishes startup and shutdown in isolation. It does not
establish real authentication retry, RTC session health or FLC/device behavior.
