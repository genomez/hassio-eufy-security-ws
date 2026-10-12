# RC3 initialization candidate qualification

This branch qualifies a configuration-only derivative of the exact public
login-retry.1 image. It restores the Home Assistant base's /init entrypoint and
uses version3.0.18-regional-rtc-rc3-login-retry.2. All nine filesystem layers must
remain identical. No application, launcher, dependency, RTC or authentication
recovery code changes are permitted by this preparation.

The dispatch-only workflow uses a disposable GitHub-hosted Ubuntu runner. It
does not execute containers on an owner's computer or Home Assistant. Public
image acquisition happens on the runner before isolated tests; every test
container has network mode none and synthetic temporary options/data only.
The workflow has contents-read permission and no registry push, release action,
installation, issue reply or reporter test invitation.

The original image's default startup is the negative control. The corrected
image must run its genuine /init, with-contenv, Bashio and /run.sh with no
entrypoint/command override. Empty options must reach the existing launcher
refusal without starting Node. Synthetic nonempty options run the real Node
CLI with a guarded fake driver at the application boundary, verifying options,
RTC defaults, local listening and graceful SIGTERM shutdown.

compare_images.py checks image configuration and all rootfs DiffIDs. The fixture
also checks the installed launcher hash. seal_export.py verifies the exact
Docker export and binds its config/verified OCI identity to the tested container
image identity. The candidate remains a qualification artifact, with no claimed
published registry digest or hardware/authentication acceptance.

Publication and any additional reporter trial require separate owner approval.
The already-used one-start/ten-minute trial is not renewed by these tests.
