# RC9 production source snapshot

Recorded September 25, 2026. This is a source reference, not a recommendation to replace a working installation or a newly published image.

## Exact source pair

The tag `regional-rtc-rc9-production-20260920` identifies both repositories:

| Component | Commit | Source |
| --- | --- | --- |
| Client | `be4ddb8e5300f539ff07fefd847d8fd58e6073af` | [Client snapshot](https://github.com/genomez/eufy-security-client/tree/regional-rtc-rc9-production-20260920) |
| Add-on, RTC overlay, and startup script | `fb3e1ee7b0a79fdc1b36cffae0105d81243a5d4f` | [Add-on snapshot](https://github.com/genomez/hassio-eufy-security-ws/tree/regional-rtc-rc9-production-20260920) |

The running version is `3.0.18-regional-rtc-rc9`, initially deployed September 20. The client includes the earlier RC3 regional compatibility ancestry and subsequent retained-command-path/handoff changes. Deployment uses the add-on overlay as well as the client checkout; the client alone is not the complete deployed composition.

The September 25 read-only audit confirmed the live client checkout at the commit above, all 33 retained overlay build-input files matching the add-on source after line-ending normalization, and the startup script matching after the same normalization. The two RTC transport/signaling compiled modules checked also matched the local built outputs. This is a scoped source audit, not a bit-for-bit reproducibility claim for the entire image.

## Observations and limits

- Approximately five days of US-account production use, not five uninterrupted days of uptime. Real outages and phone-assisted recovery occurred; RC9 has not eliminated that dependency.
- The retained September 25 log window was approximately 06:14-19:46 UTC, not the full five days. It contained 174 completed handoffs and five successful retained-path recovery probes. These are observations, not a universal success-rate measurement.
- FR/EU compatibility in RC9 has not received the same production validation. A stable RC3 installation should remain on RC3 unless its owner opts into a controlled candidate test.
- No new candidate image, stable promotion, default-branch update, or GitHub Release accompanies these tags. The add-on remains experimental.

## Preserved production settings

```text
RTC_SCTP_MAX_PACKET_BYTES=800
RTC_HANDOFF=1
RTC_PROACTIVE_RECONNECT_MS=270000
RTC_CONNECT_TIMEOUT_MS=45000
RTC_HANDOFF_CONNECT_TIMEOUT_MS=15000
RTC_CLIENT_OFFER=0
RTC_PROPERTY_REFRESH_MS=900000
```

These describe the current installation, not requirements for an unrelated implementation. Answerer/default mode remains enabled. Existing generic recovery, Mega-auth guards, FLC synchronization and safeguards, notifications, and rollback material remain unchanged.

## Packaging and installation caveats

The source tags freeze this source pair, but the historical Dockerfile still fetches the client through a mutable branch and uses floating dependency/base references. Rebuilding it later is not guaranteed to reproduce the deployed image. A future installation candidate needs separately reviewed pinned inputs, isolated tests, and explicit update/rollback instructions before asking another user to install it.

The repository's `homeassistant/` examples are not a complete export of the production installation. Site-specific HA recovery automations, Tasker/phone configuration, local HA integration customizations, and private account data are outside this snapshot. HA integration v8.2.5 is a separate component; its locally preserved image/alarm changes are not delivered by these tags. Do not copy credentials, tokens, authentication persistence, or other private configuration into issues or source control.

## Optional regional testing and new upstream work

The existing tester discussion is [issue 2](https://github.com/genomez/hassio-eufy-security-ws/issues/2). No action is required from a stable RC3 user. If the tester volunteers, the next step is preparing and validating one controlled candidate, preserving existing add-on data and a known-good rollback. Until explicit instructions are posted, leave automatic updates and `rtc_app_live_view_test` disabled.

Separately, [mega-yfue/eufy-sdk PR 243](https://github.com/mega-yfue/eufy-sdk/pull/243) is an open draft T9000 RTC implementation as of September 25. Its author reports command-channel progress, while media remains unfinished. Review and bounded reassembly/test work are being contributed separately. Neither that progress nor its newer regional findings establish a production replacement or imply those changes are present in RC9.
