# Isolated packaged-runtime qualification

Run only on the approved disposable GitHub-hosted runner:

```
python3 qualification/rc3-push-status/fixtures/qualify.py --original "$PARENT" --candidate "$CANDIDATE" --output qualification-results
```

The runner produces STARTUP_QUALIFICATION.json, PACKAGED_PUSH_STATUS.json and
PACKAGED_LOGIN_RETRY.json. Each case binds its Docker-inspected image identity.
The parent is the fixed published `.2` digest; no mutable parent tag is accepted.

Four startup cases use the actual default `/init` and unchanged launcher/CLI.
Fresh synthetic Bashio cache input substitutes only for Supervisor-provided
configuration. Empty parent and candidate inputs exercise refusal before Node.
Synthetic candidate cases preserve packet size 800, handoff 1, reconnect 270000,
client-offer 0, property refresh 900000, FLC grace 45000 and poll interval 2.
No RTC_BIND_ADDRESS is injected. The driver application boundary is fake and
network-disabled; actual cloud authentication, RTC and hardware are untested.
Graceful shutdown uses SIGTERM without a SIGKILL fallback. Running failures are
not forcibly removed; the disposable hosted runner owns eventual teardown.

The push cases retain the 20 reviewed source-fixture assertions. SDK modules
execute the exact installed CommonJS bytes via a VM with explicit imported
dependency boundaries. WebSocket command/event/state/message-handler/forward
modules execute their exact installed ESM bytes via SourceTextModule, with
SyntheticModule boundaries for unrelated dependencies. No product source is
transpiled. The installed ts-jest transforms only the fixture TypeScript.

The 34 login-retry assertions import the real installed SDK/Mega/crypto modules
through `subject/src/...` -> `/usr/src/app/client/build/...`. Their synthetic
transport asserts and consumes a fixed expected request sequence. It never
performs actual Eufy authentication or reads real persistence.

Every runtime container uses network none, no host ports, no privileges, no
Docker socket and no host PID. The only mounts are these read-only fixtures and
fresh temporary writable synthetic `/data`. No host authentication environment
is passed. Node guards deny outbound HTTP/TLS/socket/DNS/datagram/fetch,
subprocesses and workers; native RTC is stubbed before import. Startup permits
only the unchanged local `0.0.0.0:3000` listener without publishing a host port.
All receipts require zero denied-operation attempts and no forced termination.

Raw container/Jest output is not emitted or retained in artifacts. Fixed result
counts, failed-case ordinals, allowlisted startup markers and installed module
SHA-256 values are the only diagnostic receipts. There is no install, build,
network dependency resolution, production access or reporter trial here.

Hosted cleanup records STARTUP_TEMP_CLEANUP.json and PACKAGED_TEMP_CLEANUP.json.
Failed cases preserve their temporary data for disposable-runner teardown. For
completed cases only, ordinary standard-library cleanup runs first. If a
container-root cache prevents it, the helper verifies the exact allocated real
directory and inode, its runner ownership, fixed prefix and direct `/tmp` parent.
It then runs `sudo -n chown -R -P -h -- <numeric UID:GID> <exact root>` using an
argv array, captured output and a 20-second bound before retrying cleanup. It
never follows symlinks or touches a directory outside that allocated temp root.
Ownership-repair or cleanup failure preserves remaining data and emits only a
fixed phase marker. No Docker force removal or SIGKILL is introduced.
