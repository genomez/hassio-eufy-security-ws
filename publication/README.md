# Qualified RC3 startup export publication

This branch publishes only the exact startup-qualified export from Actions run
38303187102 at commit a74c9d68432ebaf39e0e07d34df11fc5fd1f5674. It does not rebuild,
start a container, publish a release or authorize installation or another trial.

The gzip export hash and complete archive identity are verified before loading.
The loaded configuration, entrypoint, command, platform, version and all ten
filesystem diff IDs must match expected-image.json before tagging or pushing.
A pre-existing version tag must verify identically; otherwise publication stops.
An identical pre-existing tag is reused without another push. Independent anonymous
verification reads the manifest, configuration and every compressed/uncompressed
layer. GITHUB_TOKEN remains ephemeral in the hosted runner; only public image
identity receipts are retained. No new credential is requested or stored.
