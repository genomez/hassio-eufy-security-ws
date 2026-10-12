# RC3 initialization candidate qualification

This branch qualifies a startup-only derivative of the exact public login-retry.1
image. It restores /init and guards two optional address-discovery assignments
against failure under Bashio errexit. Hosted diagnostics confirmed the previously
unguarded hostname lookup exited at launcher line95. The candidate uses version
3.0.18-regional-rtc-rc3-login-retry.2. All nine parent filesystem layers must remain
intact; one added layer may contain only the corrected /run.sh. No application,
dependency, RTC or authentication recovery code changes are permitted.

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
RTC defaults, local listening and graceful SIGTERM shutdown. A second synthetic
case exercises an unavailable reserved station route with no injected bind address.

compare_images.py checks image configuration and retained parent rootfs DiffIDs.
The fixture also checks the corrected launcher hash. seal_export.py verifies the
single added layer changes only /run.sh with that exact hash, then binds the exact
Docker export and binds its config/verified OCI identity to the tested container
image identity. The candidate remains a qualification artifact, with no claimed
published registry digest or hardware/authentication acceptance.

Publication and any additional reporter trial require separate owner approval.
The already-used one-start/ten-minute trial is not renewed by these tests.
