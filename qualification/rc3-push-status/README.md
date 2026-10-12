# Push-status candidate composition

This derivative retains the exact published `.2` parent, including all ten
filesystem layers, dependencies, `/init`, `/run.sh`, runtime defaults and the
existing WebSocket package. Only compiled bytes resulting from the approved
two-file SDK correction can enter the final filesystem layer. The only runtime
configuration change permitted is the image-version label.

The compiler stage uses the parent's existing TypeScript 5.9.3 and dependency
tree with networking disabled. It compiles the frozen baseline and candidate
with their production configuration and fails unless every baseline emission
is byte-identical to the parent. Candidate emissions must have the same file
set; differences are restricted to the two SDK modules and their declarations
and source maps. The final stage copies only genuinely changed compiled files.
Source inputs, tests, compiler receipts and tooling remain outside the final
image.

Build the `compiler` target first on the isolated hosted runner and copy
`/qualification/COMPILATION_COMPARISON.json` from a created, unstarted compiler
container. Build the final `candidate` target using the same cache. Neither
target performs a package-manager operation or cloud/device interaction.

`compare_images.py` verifies inherited runtime metadata and layer identities.
After isolated startup and packaged regression fixtures pass, `seal_export.py`
checks the exact Docker export's config, every uncompressed layer digest, and
every added file against the compiler receipt. It requires passing startup,
push-status and login-retry receipts and binds their tested image identities to
the exact exported config. A hosted runner using a containerd target digest is
accepted only when the export contains that exact digest and its manifest binds
the exported config cryptographically.

The qualification covers synthetic application boundaries and startup. It
does not verify notification delivery, real authentication, native RTC/FLC,
Supervisor installation or a reporter trial. No registry publication is part
of this workflow; the sealed export is a review artifact.
