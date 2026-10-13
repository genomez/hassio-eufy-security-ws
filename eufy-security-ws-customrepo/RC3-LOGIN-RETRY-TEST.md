# RC3 startup-read coordination candidate (amd64)

This guide and image publication do not authorize installation, startup, authentication or another trial. The previous `.3` single-start allowance has been used. Keep the candidate stopped until the maintainer's complete issue #2 comment explicitly grants the conditional `.4` procedure below. Keep automatic updates/restarts, watchdog and start-on-boot disabled, and `rtc_app_live_view_test` false. A later conflicting instruction takes precedence.

The descriptor preserves the repository basename and selects the `.4` tag; it is not a digest-pinned Supervisor selector. Before a separately authorized start, require the full exact verified RepoDigest and image ID below.

I prepared `.4` before sending further trial instructions. Source review found overlapping producers for the same startup camera-info read. This candidate combines identical reads at each startup checkpoint, bounds pending camera-info work and retains a newer refresh when it arrives during an earlier request. Later periodic/FLC refresh purposes, existing ACK handling, watchdog/RTSP behavior, authentication retries and RTC/FLC defaults are preserved. ACK completion and property-data arrival remain separate observations.

It also adds fixed legacy-push request categories and numeric HTTP/backend codes, plus fixed RTC command/channel/correlation/timing fields. Raw token, body and error context are omitted from these specific diagnostic paths. Other SDK logs are not generally safe to share. This does not establish the cause of `-1`, `-104` or `-114`, or guarantee that they disappear.

The candidate passed four isolated default-startup cases, 20 compiled SDK/WebSocket push-status cases, 34 unchanged login-retry cases and 82 compiled SDK coordination/diagnostic cases. All 192 baseline compiler emissions reproduced the parent; the candidate has 198 emissions plus the same six runtime assets. It retains all eleven `.3` filesystem layers and adds one layer containing only the approved compiled changes. Launcher, dependencies and runtime defaults are unchanged. These synthetic checks do not validate real authentication, native RTC/FLC, notification delivery or Supervisor installation.

Version: `3.0.18-regional-rtc-rc3-login-retry.4`, linux/amd64.

Image repository: `ghcr.io/genomez/eufy-security-ws-rc3-login-retry-amd64`.

Configuration digest: `sha256:4f07c46b42d3d35e04adbd7101f05333cb4ac734a6be472ad5634a2d87dcf1e3`.

Immutable registry manifest: `sha256:8e75f28d65f5a0e0c05aa04cdcf420ecc45d779c1326bab561aaef8248ed907f`.

Full RepoDigest: `ghcr.io/genomez/eufy-security-ws-rc3-login-retry-amd64@sha256:8e75f28d65f5a0e0c05aa04cdcf420ecc45d779c1326bab561aaef8248ed907f`.

Qualification: https://github.com/genomez/hassio-eufy-security-ws/actions/runs/38415872582

Authenticated publication verification and an independent anonymous immutable-manifest read verified the configuration and all twelve compressed/uncompressed layers against the exact sealed export. Configuration and registry manifest digests are different identities; do not substitute one for the other.

Publication: https://github.com/genomez/hassio-eufy-security-ws/actions/runs/38418913719

Only a separately posted maintainer comment authorizes this conditional procedure. Once that comment permits the new `.4` trial and all prerequisites pass, follow A through D without an additional correspondence round. Nothing in this guide reuses or extends the `.3` trial; no manual device/service commands are included.

## A. Update and verify while stopped

1. Keep `.3` stopped. Keep automatic updates/restarts, watchdog and start-on-boot disabled, and `rtc_app_live_view_test` false. Preserve account data/options and existing RTC/FLC settings. Do not add a repository or install another instance.
2. Verify locally that the existing original stopped RC3 recovery copy, matching data/options, retained original image and private original image reference/ID are available. Do not overwrite them with a later candidate copy. If recovery is missing or ambiguous, leave the slot stopped and do not update.
3. Refresh only the existing repository entry on `regional-rtc-stable-v1`, then manually update only `2cc5798a_eufy_security_ws_customrepo` to `.4`. Preserve data/options; do not uninstall, rebuild, restore unrelated components or start it during preparation.
4. Inspect only the candidate image's ID, OS, architecture and RepoDigests using the limited image-metadata format from the prior procedure. Require version `.4`, linux/amd64, the exact full published RepoDigest above, and full image ID matching the verified configuration or manifest digest as appropriate to the image store. A label or short prefix is insufficient. Do not share full inspection output, environment or account data.
5. Confirm the page remains stopped and repeat the prior limited container-state check for this slot's two possible container names. A missing container is acceptable; any existing container must be stopped (`running=false`, status `exited` or `created`). A stopped older container is not evidence of a candidate mismatch; do not start to replace it.

For step 4, inspect only fixed candidate metadata:

```sh
docker image inspect \
  'ghcr.io/genomez/eufy-security-ws-rc3-login-retry-amd64:3.0.18-regional-rtc-rc3-login-retry.4' \
  --format 'ID={{.Id}} OS={{.Os}} ARCH={{.Architecture}} DIGESTS={{json .RepoDigests}}'
```

For step 5 and final stopped-state confirmation:

```sh
docker container inspect \
  --format '{{.Name}} running={{.State.Running}} status={{.State.Status}}' \
  app_2cc5798a_eufy_security_ws_customrepo \
  addon_2cc5798a_eufy_security_ws_customrepo
```

If a prerequisite fails before updating, do not update or start; report only the failed check. If the update or post-update identity/stopped-state checks fail, follow C. If the maintainer comment has granted this new trial and all checks pass, proceed directly to B without another correspondence round.

## B. One passive start, strictly less than ten minutes including startup

Reconfirm A and prepare a visible 9:30 Stop prompt plus an independent ten-minute deadline alert. Alerts do not guarantee shutdown. Press Start once and begin elapsed timing immediately at that action. Never extend timing for delayed login or handoff. No restart after an exit or second start is included. Stop immediately if elapsed time becomes uncertain. If these safeguards cannot reliably be followed, do not begin.

Observe initialization, login/HomeBase connection and approximate timing. Existing logic permits at most one fresh key-exchange/login retry after an initial `4404`. Do not reset authentication, delete persistence, invoke a heal, enter verification/captcha, manually wake devices or exercise app live view.

Passively compare HA push-connected status with actual transport connection/close events. Note fixed legacy check/register categories and numeric HTTP/backend codes separately from Mega registration. Connected transport is not proof of successful registration or notification delivery. Missing transitions remain untested; do not force them or continue longer.

The fixed messages are `RTC camera info coordination`, `RtcCommandBridge command ack` and `Legacy push request`. Observe camera-info event/reason/generation/pending/queued/trailing/elapsed fields and selected numeric ACK/correlation fields (`expectedCommandID`, `actualCommandID`, `expectedChannelID`, `actualChannelID`, `responseFlag`, `commandMatches`, `channelMatches`, `pendingCount`, `elapsedMs`, `returnCode`). ACK completion and camera-info payload arrival are separate observations. Do not paste log lines or raw response data; mark unavailable fields unavailable and preserve the existing logging configuration.

Observe only natural RTC handoff and normal passive FLC synchronization. Do not change guard mode or toggle lights in HA or the official app. Do not issue manual device/service commands or manufacture a reconnect/notification. Preserve packet size 800, handoff 1, reconnect 270000 ms, answerer/default mode, property refresh 900000 ms and existing FLC settings.

Stop immediately for repeated `4404` after the single retry, verification/captcha/lockout, unexpected exit, explicit login/RTC startup failure, continued missing RTC credentials after startup completes, repeated negative ACKs after startup, unexpected reconnect loops, unexpected guard changes or actual push/RTC/device/FLC disruption. Early waiting alone is not a failure diagnosis. No connection by the deadline is a failed observation.

Initiate Stop by 9:30, earlier if shutdown might take longer, and confirm fully stopped strictly before ten minutes. Verify the page and limited container-state check. Failure to confirm stopped before ten minutes fails the safeguard; it never permits continued observation, another start or an authentication/recovery attempt during the timed trial. Leave a successful `.4` installed but stopped. Continued operation needs a new owner decision.

## C. Recovery if update or trial fails

After confirming the slot is stopped, restore only this existing Eufy slot from its preserved original stopped RC3 recovery copy, including the saved image and matching data/options. If stopped state cannot be confirmed, preserve recovery material and report the failed check; do not restore a running slot. Do not broaden recovery to HA or unrelated components, uninstall/rebuild as a workaround or authenticate again to improve the result. The separately authorized procedure permits only that narrow post-stop fallback. It does not permit a further start, authentication attempt or unrelated recovery.

Verify original version `3.0.18-regional-rtc-rc3`, safeguards and stopped state. Compare the restored full image ID with the private original record locally, and repeat the limited stopped-container check. A restore-success notification alone is insufficient. Restoration was source reviewed, not rehearsed on your installation. If verification fails, preserve recovery material, leave stopped and report only the failed check; do not start or retry authentication.

Only locally, substitute the existing private original image reference:

```sh
docker image inspect 'YOUR_PRIVATE_SAVED_RC3_IMAGE_REFERENCE' --format '{{.Id}}'
```

## D. One consolidated sanitized outcome and next steps

Report identity matched or failed check; startup/login/HomeBase timing and retry count; elapsed time when Stop was initiated and when stopped was confirmed; final stopped state, actual start count (zero if aborted before B, otherwise one) and zero manual commands; recovery verification if needed. Note natural handoffs and passive FLC observations. Missing transitions remain untested and must not be manufactured.

Include only selected fixed fields, not log excerpts: camera-info event/reason/generation/pending/queued/trailing/elapsed values; negative ACK counts and numeric return codes, expected/actual command/channel, response flag and match booleans, pending count and elapsedMs; legacy push operation/category and finite HTTP/backend code or fixed error class. Separate startup from later recurrence. Image identity, numeric command metadata and fixed correlation fields are permitted; sensitive account/device/station identities and payloads are not.

If bounded observations pass, leave `.4` installed but stopped. I will compare duplicate scheduling and command-correlated ACKs with `.3`, then review remaining legacy error classification. If they fail, follow C and remain stopped. Either outcome gets a source-backed next-step proposal; it does not authorize another start, a longer trial, forced notification/FLC tests or production rollout. No additional historical report is due before this procedure.

Never share credentials, PINs, tokens, sensitive account/device identities, private recovery records, backups, configuration/persistence files, raw inspection output, raw requests/responses or authentication logs. No operation on my current production stack is involved.
