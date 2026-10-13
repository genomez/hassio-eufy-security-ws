# Exact push-status image publication verification

This directory publishes and verifies the already-qualified `.3` image export. It does not rebuild the image or start any container. Expected identity comes from qualification run `38323568379` and `QUALIFIED_CANDIDATE.json`; `source_commit` identifies the approved SDK source commit, not the workflow checkout commit.

The fixed repository is `ghcr.io/genomez/eufy-security-ws-rc3-login-retry-amd64`, version `3.0.18-regional-rtc-rc3-login-retry.3`. The verifier requires exact qualified config digest, Linux/amd64, `/init`, `/run.sh`, the version label and all eleven root filesystem diff IDs. For each registry layer it streams and checks the compressed digest and declared size, then the uncompressed digest against qualification. The exact config digest also binds the complete configuration and labels.

Commands:

```
python publication/verify_registry.py preflight
python publication/verify_registry.py authenticated
python publication/verify_registry.py anonymous --expected-manifest sha256:<verified-manifest-digest> --output <receipt.json>
```

Hosted `preflight` and `authenticated` modes use only ambient `GITHUB_ACTOR` and `GITHUB_TOKEN`. Anonymous mode obtains a public GHCR pull token transiently in memory; it reads the supplied immutable manifest reference when `--expected-manifest` is present. Redirected requests do not carry registry authorization headers. No authentication values, token response bodies, signed URLs or arbitrary exception text are printed or written.

Preflight defaults to `registry-preflight.json`. Only a manifest-tag HTTP 404 after successful token retrieval means `exists: false`. An existing tag must pass the same full verification as publication, producing `exists: true`; a different image fails without a successful receipt. The publication workflow must skip pushing an existing exact image and must never replace a conflicting tag. Authentication, transport and other HTTP failures are failures, not evidence of tag absence.

Authenticated and anonymous verification default to `registry-identity.json`; `--output` selects a receipt path. Receipts contain fixed image identity and public manifest/config/layer metadata only. Errors emit only a fixed failure marker and exception type. A supplied expected manifest must be a canonical lowercase SHA-256 digest and must match both fetched bytes and the registry digest header.

Registry verification establishes publication identity and layer integrity. It does not demonstrate real authentication, notification delivery or hardware RTC/FLC behavior.
