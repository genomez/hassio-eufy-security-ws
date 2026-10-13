# Private startup-coordination candidate composition

This composition retains the exact published `.3` parent at
`ghcr.io/genomez/eufy-security-ws-rc3-login-retry-amd64@sha256:8cb3d1854beb428803be7e50dcd038faf4b24ed0bfe3c4e7d63b62cec2c67a57`.
Its eleven filesystem layers, dependency tree, launcher, `/init`, runtime
defaults and WebSocket package remain inherited. A single final layer contains
only changed compiled bytes from the eight approved SDK modules, including the
six emissions for the two new helper modules. The only runtime configuration
change is the image-version label, `3.0.18-regional-rtc-rc3-login-retry.4`.

`EXPECTED_PARENT.json` starts unsealed. Compilation, image comparison and export
sealing fail until the source commit, complete frozen source hash maps and exact
fixture receipt contracts are bound and `inputSealed` becomes true. The parent
config, export hash, launcher hash and eleven diff IDs are copied from the
independently qualified `.3` receipt; its previous candidate source hashes are
not reused as this candidate's frozen hashes.

1. On the isolated hosted runner, build the `compiler` target. Its sole command
   runs with networking disabled, using only the parent's TypeScript 5.9.3 and
   dependencies. The parent build has 198 files: 192 compiler emissions and six
   inherited assets (one certificate, three protocol files and libsctp JS/WASM).
   Those six fixed asset paths and their full SHA-256 values are pinned in
   `EXPECTED_PARENT.json` and verified independently of compilation. All 192
   baseline emissions must exactly reproduce the parent's emission inventory;
   all 198 candidate emissions must retain the baseline inventory plus exactly
   six new helper emissions. The inherited assets remain unchanged, making 204
   files in the final candidate build. Copy `/qualification/COMPILATION_COMPARISON.json`
   from a created, unstarted compiler container.
2. Build the final `candidate` target with the same cache. Only genuinely changed
   compiled `.js`, `.js.map` and `.d.ts` files from the eight approved module
   basenames can enter its new layer. Source files, tests, compiler artifacts,
   dependencies and tooling stay outside that layer.
3. Run `compare_images.py` and the isolated startup and packaged regression
   fixtures. Four startup cases must finish successfully with networking
   disabled and no forced termination. Packaged push-status, login-retry and
   coordination receipts must meet their frozen counts (20, 34 and 82) and exact
   module hashes. Coordination includes 40 scheduling cases, 40 safe diagnostic
   cases and two baseline semantic controls. It hashes all sixteen required
   installed modules; its execution claim covers the actual compiled SDK, while
   the existing push fixture covers the actual compiled WebSocket package.
4. Save the private candidate and run `seal_export.py`. The seal checks every
   uncompressed layer digest, final-layer paths, root ownership, directory mode
   0755, file mode 0644, actual exported module bytes, retained launcher and all
   tested image identities against the exact export. It reconstructs the entire
   parent build (192 emissions plus six pinned assets) and the entire candidate
   build (198 emissions plus those same six assets), and requires byte identity
   for all inherited assets. Its qualified receipt is
   written only after these checks pass.

The image remains private and unpublished. Qualification covers synthetic
application boundaries and startup; real authentication, notification delivery,
native RTC/FLC, Supervisor installation and a reporter trial remain outside this
artifact's qualification.
