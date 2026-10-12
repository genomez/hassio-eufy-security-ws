# RC3 startup-corrected login retry candidate (amd64)

Version `3.0.18-regional-rtc-rc3-login-retry.2` is published and available through
this experimental branch. Publication is not authorization to install, start,
authenticate or conduct another trial. The prior single-start allowance has
already been used. Keep the installed candidate stopped and existing automatic
update, watchdog/restart and start-on-boot safeguards disabled pending new
maintainer instructions. Keep Test5 (`rtc_app_live_view_test`) false.

## Verified artifact identity

- Repository: `ghcr.io/genomez/eufy-security-ws-rc3-login-retry-amd64`.
- Version: `3.0.18-regional-rtc-rc3-login-retry.2`.
- Immutable registry manifest: `sha256:28aeceae1c53c8d2d1351a51801c2f75b386243321e19146f78d910d509e0cea`.
- Full RepoDigest: `ghcr.io/genomez/eufy-security-ws-rc3-login-retry-amd64@sha256:28aeceae1c53c8d2d1351a51801c2f75b386243321e19146f78d910d509e0cea`.
- Configuration digest: `sha256:fe4999e18adfd5a04a270bb6e0724e6a172646a68818d27c0a439774359b7fa7`.
- Platform: `linux/amd64`.
- Qualified gzip export SHA-256: `d96ca78fbb13d4462d8cdfef0c67fca3f1b5fbfbdd6bb266546eed20e6f43e4f`.

Authenticated publication verification and an independent anonymous registry
read matched the configuration and every compressed/uncompressed layer against
the exact qualified export. The descriptor preserves its repository basename
and selects the `.2` version tag; it is not a digest-pinned Supervisor selector.
Before any separately approved start, require the exact full RepoDigest above
and matching linux/amd64 platform. Docker inspect `.Id` may be the configuration
digest or manifest digest depending on image-store implementation; accept only
those exact full values together with the correct RepoDigest. A display name,
short hash or version label alone does not establish installed image identity.

## What changed and what was qualified

The candidate restores the base image's `/init` entrypoint while retaining
`CMD ["/run.sh"]`, and guards two optional route/hostname lookups. All nine parent
filesystem layers are retained; only `/run.sh` differs. Compiled application,
authentication, RTC/FLC code and dependencies are unchanged.

[Startup qualification run 38303187102](https://github.com/genomez/hassio-eufy-security-ws/actions/runs/38303187102)
at commit `a74c9d68432ebaf39e0e07d34df11fc5fd1f5674` passed four isolated cases:
original exit111 reproduction, corrected missing-credentials refusal, synthetic
CLI startup/shutdown, and unavailable-route fallback startup/shutdown. The
synthetic cases used the genuine `/init`, launcher, Bashio and CLI path with a
fake Eufy driver and networking disabled. They do not establish real Supervisor
integration, cloud authentication, FR/EU hardware or long-run RTC/FLC reliability.
Earlier offline application tests remain limited to their synthetic scope.

[Publication run 38305482317](https://github.com/genomez/hassio-eufy-security-ws/actions/runs/38305482317)
loaded and pushed the exact tested export; it did not rebuild or start it.
The correction addresses the reproduced initialization failure, not proof of
a fix for the earlier reported outage or real initial Mega login failure.

## Preserve the existing slot and recovery

Use only the existing `regional-rtc-stable-v1` repository entry and add-on slot;
no new instance, branch or repository URL is needed. Slot, option schema and
permissions are unchanged. Preserve the original stopped RC3 backup, matching
data/options, old image and private recovery identity; do not overwrite them
with candidate recovery copies. Do not share credentials, PINs, tokens, backups,
persistence, raw authentication logs or private recovery records.

A separately approved installation must finish at an identity-verified stopped
checkpoint. A new start, trial window or continued operation needs a separate
explicit decision. Preserve packet800, handoff1, reconnect270000 ms, answerer
mode and property refresh900000 ms; do not change RTC/FLC settings or invoke a
heal/authentication reset. The maintainer's production stack is excluded.
