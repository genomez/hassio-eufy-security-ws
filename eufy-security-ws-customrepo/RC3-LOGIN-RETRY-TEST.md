# Optional RC3 login retry test (amd64 only)

This is an experimental RC3-derived candidate for the initial Mega login 4404
path. It is not a proven explanation or fix for the reported outage. Offline
qualification passed 86 compiled login/recovery cases and 37 RTC cases, plus
native/WASM load, launcher and fake-driver routing/shutdown checks. Real FR/EU
hardware behavior, Supervisor admission and long-run recovery remain unverified.

Version: `3.0.18-regional-rtc-rc3-login-retry.1`.
Image: `ghcr.io/genomez/eufy-security-ws-rc3-login-retry-amd64`.
Registry manifest: `sha256:897eeac38d4cff847083c4d8f16519e825f15883120812280a2dcda5061482ee`.
Image config/ID: `sha256:d2747d8a57527afefdbc07f5e8942bfae435ba1055f6c828d05313c58e158490`.
The manifest and config IDs are different identifiers. Registry config and all
nine layers have been compared with the qualified export.

## Before installing

1. Reconfirm with the maintainer your current add-on repository URL, installed
   add-on slug, and amd64 architecture. Earlier testing used
   `regional-rtc-stable-v1`; use your existing repository entry and slot only.
   Do not add a new repository URL/branch or install another instance. This
   update is available to everyone following that experimental branch; it is
   not a default-branch production release. Before updating, turn automatic
   updates, watchdog/automatic restarts, and start-on-boot off, and keep RC3
   stopped.
2. Keep RC3 stopped. Save a local full add-on backup including matching data and
   options. Retain the old RC3 image and verify locally that the backup and old
   image/version are actually available for restore. A backup alone does not
   prove that the old image can be recovered. If recovery cannot be verified,
   do not install or start. All account information stays private.
3. After those prerequisites are confirmed, refresh the existing store entry
   and manually update that existing slot. Retain its data/options and RTC/FLC
   settings. Keep Test5 (`rtc_app_live_view_test`) false, automatic updates and
   watchdog/automatic restarts off, and start-on-boot off during the test. Check
   the selected version and actual installed image identity locally against
   the manifest/config IDs above before authentication. A display name or
   version string alone is insufficient. If the identity differs or is not
   verifiable, leave it stopped and report that outcome; do not start to obtain
   more evidence. No new credentials or raw authentication artifacts are shared.

## One bounded start

4. Start once, observe for at most 10 minutes, then stop. The candidate permits
   at most one fresh key exchange/login retry following an initial 4404; it
   does not automatically retry supplied verification/captcha. Do not reset
   authentication, delete persisted data, invoke a heal, manually wake devices,
   open app live view for a test, or replay verification/captcha.
5. If it connects, you may choose at most one ordinary guard-mode command that
   is safe for your current physical state, and verify the result locally in
   the app or physically. Observe natural RTC operation across at least one
   270-second handoff and normal floodlight/light synchronization. Do not
   toggle floodlights solely to create a test. If it does not connect, do not
   issue commands. Preserve packet 800, handoff 1, reconnect 270000 ms, answerer
   mode, and property refresh 900000 ms.
6. Stop immediately for repeated 4404 after the single retry, any challenge or
   lockout, unexpected exit, continued missing RTC credentials, a failed
   intended command, or unrelated RTC/device/FLC disruption. Stop before
   entering interactive verification. There is no automatic second start or
   extended observation window.

## Recovery and report

7. If the stop conditions occur, restore the old RC3 image with its matching
   backed-up data/options locally. Leave it stopped as it was before the test.
   Do not authenticate again to improve the result. Even a successful test
   ends at 10 minutes with the candidate stopped; any longer use is a separate
   decision.
8. Share only sanitized outcomes and counts/timing: whether it started and
   connected, whether the single retry occurred, command success if attempted,
   handoff/FLC observations, and any stop reason. Do not share credentials,
   PINs, tokens, session/persistence files, raw requests/responses or auth logs.
   No replacement request for the missing October 5 log or old image digest is
   part of this test.

The default branch and the maintainer's current production stack are outside
this test. Initial login succeeds or fails independently of whether the
reported historical incident is explained.
