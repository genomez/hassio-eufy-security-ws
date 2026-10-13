# RC3 push-status-corrected login retry candidate (amd64)

Version `3.0.18-regional-rtc-rc3-login-retry.3` is an experimental correction
to the qualified `.2` image. Publication and this guide do not authorize
installation, startup, authentication or another trial. The previous `.2`
single-start allowance has been used. Keep the candidate stopped until the
maintainer's complete issue #2 comment explicitly grants the conditional `.3`
procedure below. Keep automatic updates/restarts, watchdog and start-on-boot
disabled, and Test5 (`rtc_app_live_view_test`) false.

## Verified artifact identity

- Repository: `ghcr.io/genomez/eufy-security-ws-rc3-login-retry-amd64`.
- Version: `3.0.18-regional-rtc-rc3-login-retry.3`.
- Immutable registry manifest: `sha256:8cb3d1854beb428803be7e50dcd038faf4b24ed0bfe3c4e7d63b62cec2c67a57`.
- Full RepoDigest: `ghcr.io/genomez/eufy-security-ws-rc3-login-retry-amd64@sha256:8cb3d1854beb428803be7e50dcd038faf4b24ed0bfe3c4e7d63b62cec2c67a57`.
- Configuration digest: `sha256:7804976f8005b424b912ac3721eac04441d42a5323c37fcc2b52b6179ff662d1`.
- Platform: `linux/amd64`.
- Qualified gzip export SHA-256: `20dcf91e6118a9e8f9eab4af6ec07e92ce0fd3f16eb5fa24f9bc427348082fcb`.

Authenticated publication verification and an independent anonymous immutable
manifest read verified the configuration and every compressed/uncompressed
layer against the exact qualified export.
The descriptor preserves its repository basename and selects the `.3` tag;
it is not a digest-pinned Supervisor selector.

Before any separately approved start, require the full exact RepoDigest and
`linux/amd64`. Docker inspect `.Id` may be the configuration digest or manifest
digest depending on the image store; accept only those verified full values
together with the correct RepoDigest. A version label, short hash or display
name is insufficient. Keep image verification local; never post raw inspect
output or private recovery identities.

## What changed and what was qualified

The SDK getter describes push transport connectivity. Previously, connection
events also depended on legacy cloud-registration results, and the push service
emitted connect/close before updating its own connection flag. The correction
makes those status paths agree and prevents delayed registration completions
from publishing stale transport events. The existing legacy-register,
legacy-check and Mega-register request order and login retry behavior remain.
Backend work still follows its existing lifecycle; this does not cancel it or
resolve other underlying credential/shutdown races.

[Qualification run 38323568379](https://github.com/genomez/hassio-eufy-security-ws/actions/runs/38323568379)
at commit `22a5d14c09fd291bcae204224acaeae618574e8c` passed four isolated
default-startup cases, 20 cases exercising the installed compiled SDK/WebSocket
push-status paths and 34 unchanged compiled login-retry regression cases.
The startup cases covered the `.2` missing-credentials refusal, the `.3`
missing-credentials refusal, synthetic CLI startup/shutdown and unavailable-route
fallback startup/shutdown. Networking was disabled and application boundaries
were synthetic.

Recompiling the unchanged source reproduced all 192 installed outputs byte for
byte. All ten `.2` filesystem layers remain; one added layer changes five
compiled files from only the two approved SDK modules. The `/init` entrypoint,
launcher, dependencies and RTC/FLC source and defaults remain unchanged.
Publication loads and pushes this exact tested export without rebuilding or
starting it.

These checks do not establish real authentication, notification delivery,
Supervisor integration, native RTC or physical FLC behavior. The correction
does not repair or explain legacy `10003`, prove that startup negative
acknowledgments are harmless, explain the third guard-related acknowledgment,
or establish long-run reliability. Connected push transport is not proof that
cloud registration succeeded or that a notification was delivered.

## Preserve the existing slot and recovery

Use only the existing `regional-rtc-stable-v1` repository entry and slot
`2cc5798a_eufy_security_ws_customrepo`. Do not add a repository or install another
instance. Slot, image template, option schema and permissions remain unchanged.
Keep existing RTC/FLC settings: packet size 800, handoff 1, reconnect 270000 ms,
answerer/default mode and property refresh 900000 ms. Do not invoke a heal or
reset authentication. The maintainer's production stack is excluded.

Before an approved update, verify locally that the original stopped RC3 backup,
matching data/options, retained original image and private original image
reference/ID are available. Do not overwrite them with a `.1`, `.2` or `.3`
backup. If recovery is missing or ambiguous, leave stopped and do not update.
Never share credentials, PINs, tokens, backups, configuration/persistence files,
raw requests/responses, authentication logs or private recovery records.

## Conditional update and one passive trial

This section applies only after the maintainer's complete issue #2 comment
explicitly authorizes it. It does not renew the earlier `.2` start allowance.

### Update and verify while stopped

1. Reconfirm disabled automatic updates/restarts, watchdog and start-on-boot,
   Test5 false, unchanged account data/options and available original recovery.
2. Refresh only the existing repository entry, then manually update only the
   existing slot to `.3`. Preserve data/options. Do not uninstall, rebuild,
   restore unrelated components or start the add-on.
3. Verify its page reports the full `.3` version. Inspect only the `.3` image
   locally, requiring the exact verified RepoDigest, allowed full `.Id` and
   `linux/amd64`. Do not substitute a label or short prefix.
4. Confirm the page remains stopped. Inspect only
   `app_2cc5798a_eufy_security_ws_customrepo` and
   `addon_2cc5798a_eufy_security_ws_customrepo` for running/status. A missing
   container is acceptable. Any existing container must be `running=false`,
   with status `exited` or `created`. A stopped older container is not evidence
   of an image mismatch; do not start to replace it.

If a prerequisite fails before updating, leave stopped and report only the
failed check. If the update or a post-update identity/stopped-state check fails,
stop and follow recovery below. If all checks pass and the maintainer has
authorized this procedure, proceed directly to the one passive trial using the
exact verification commands in that comment.

### One start, maximum ten minutes including startup

Have a ten-minute timer ready, press Start once and start the timer immediately.
Never extend it for delayed login or handoff. No restart after an exit or second
start is included. Stop immediately if elapsed time becomes uncertain.

Observe initialization, login/HomeBase connection and approximate timing. The
existing logic allows at most one fresh key-exchange/login retry after an initial
`4404`. Do not reset authentication, delete persisted data, invoke a heal, enter
verification/captcha, wake devices manually or exercise app live view.

Passively compare HA push-connected status with transport connection/close
events and note backend warning timing. A legacy `10003` warning alone with
live transport does not establish a transport failure. Observe naturally
occurring RTC handoff, FLC/light synchronization and notifications only. If a
suitable event does not occur, mark the observation untested; do not force a
transition, reconnect or extend the trial. Do not change guard mode, toggle
lights or issue any manual device/service command through HA or the official app.

Stop immediately for repeated `4404` after the one retry, verification/captcha
or lockout, unexpected exit, explicit login/RTC startup failure, continued
missing RTC credentials after startup completes, unexpected guard-mode change,
or actual push/RTC/device/FLC disruption. Stop before interactive verification.
Early startup waiting alone is not a failure diagnosis; no connection by the
deadline remains a failed observation.

Initiate Stop at nine minutes thirty seconds, earlier if shutdown might take
longer, so the add-on is fully stopped by the ten-minute hard limit even if all
observations succeeded. Verify the page and limited container check show
stopped. Leave a successful `.3` installed but stopped. Continued operation or
another start requires a new maintainer decision.

### Recovery if update or trial fails

Stop the existing slot and restore only that Eufy add-on from the original
stopped RC3 backup, including its saved image and matching data/options. Do not
broaden recovery to HA or unrelated components, uninstall/rebuild as a workaround
or authenticate again to improve the result.

Verify version `3.0.18-regional-rtc-rc3`, safeguards and stopped state. Compare
the restored image's full ID with the private original record using the
maintainer's limited image-inspection command. Repeat the limited container
check: a missing container is acceptable; any existing container must remain
stopped. A restore-success notification alone is insufficient. Supervisor
restoration was source reviewed, not rehearsed on this installation.
If verification fails, preserve recovery material, leave stopped and report
only the failed check; no startup or authentication retry.

### One consolidated sanitized outcome

After the newly authorized trial, report installation/identity match or failed
check; initialization and login/HomeBase timing; whether the single `4404` retry
occurred; push-status consistency and warning timing; natural handoff observed
or unobserved; passive FLC observations; stop reason, measured total runtime,
final stopped state, start count and confirmation of zero manual device actions;
and recovery verification if needed. Include naturally observed notification
delivery only if it occurred without manufacturing a test. No additional
historical report is due before this procedure. Do not provide raw logs or
authentication/recovery material.
