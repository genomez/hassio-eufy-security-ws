# Qualified RC3-derived amd64 image

Version: `3.0.18-regional-rtc-rc3-login-retry.1`.

This publication loads the sealed image export and pushes it without building,
relabeling or starting a container. The draft GitHub release is transport storage;
it must remain a draft so the inherited release-published builder is not triggered.
The experimental tester descriptor is updated separately after anonymous registry
verification. The default branch is unchanged.

The one-file client product change is in [login-retry.patch](login-retry.patch),
against client commit `d73b12f19fe73de2be8eff9ea7a2b2f88fe00149` in
`genomez/eufy-security-client`. Initial passport/login error 4404 permits one fresh
key exchange and login retry. Same-client initial requests coalesce, login requests
are serialized, and ownership checks fence replaced or cleared clients. Supplied
verification and captcha are not automatically retried or replayed. Persisted
authentication is not deleted.

Add-on reference: `7752652b438a962269e5b57d564325a6cb0fdfe8` in this repository.
WebSocket source: `cb7534d7c5ee55a02ef0ab99c2275009dcb69282` in
`bropat/eufy-security-ws`, plus the add-on reference's Mega driver patch and two
station overlays. The complete accepted client replaces the client build; stale
client overlays are not applied over it. The runtime launcher includes the
qualification stage's missing-credentials guard and synthetic-fixture-tested
handoff. Frozen inputs and receipts are retained by the maintainer.

Sealed export SHA256:
`b05c31f045ebd6d33fbc008a5fce3f1442f6aa8ef667d7525756c9e395a02638`.

Image config/ID:
`sha256:d2747d8a57527afefdbc07f5e8942bfae435ba1055f6c828d05313c58e158490`.
This is distinct from the registry manifest digest. The verifier binds the
manifest, exact config and all nine compressed/uncompressed layer hashes.

Offline qualification: 86 compiled login/recovery regression cases and 37 RTC
cases passed. Native module/WASM load, launcher defaults, fake-driver routing and
fake-driver CLI SIGTERM passed. Runtime rebuild comparison matched 22,026 entries.
These are synthetic/offline results: no real account, station or production system
was used. Real FR/EU behavior, persistence, Supervisor admission and long-run
recovery remain unverified. This does not establish the reporter's root cause.

The image retains inherited Home Assistant base labels and development
dependencies. Its config is preserved exactly; this is an experimental tester
package, not a metadata or dependency modernization.
