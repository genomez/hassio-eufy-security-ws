"""Bind the exact qualified Docker export without publishing it."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument("--export", required=True)
parser.add_argument("--results", required=True)
args = parser.parse_args()
archive_path, output = Path(args.export), Path(args.results)
expected = json.loads((Path(__file__).parent / "EXPECTED_PARENT.json").read_text())
comparison = json.loads((output / "IMAGE_COMPARISON.json").read_text())
startup = json.loads((output / "STARTUP_QUALIFICATION.json").read_text())
assert comparison["passed"] and startup["passed"]
with archive_path.open("rb") as handle:
    export_sha = hashlib.file_digest(handle, "sha256").hexdigest()
with tarfile.open(archive_path, "r:gz") as archive:
    manifests = json.load(archive.extractfile("manifest.json"))
    assert len(manifests) == 1
    manifest = manifests[0]
    config_bytes = archive.extractfile(manifest["Config"]).read()
    config_digest = "sha256:" + hashlib.sha256(config_bytes).hexdigest()
    config = json.loads(config_bytes)
    assert config["architecture"] == "amd64" and config["os"] == "linux"
    assert config["config"]["Entrypoint"] == ["/init"]
    assert config["config"]["Cmd"] == ["/run.sh"]
    assert config["config"]["Labels"]["org.opencontainers.image.version"] == expected["candidateVersion"]
    assert config["rootfs"]["diff_ids"] == expected["diffIds"]
    assert len(manifest["Layers"]) == len(expected["diffIds"])
    for layer, digest in zip(manifest["Layers"], expected["diffIds"]):
        assert "sha256:" + hashlib.file_digest(archive.extractfile(layer), "sha256").hexdigest() == digest
    tested_ids = {case["imageId"] for case in startup["cases"] if case["case"].startswith("corrected-")}
    assert tested_ids and len(tested_ids) == 1
    assert len(startup["cases"]) == 3
    def bind_identity(ident):
        # Classic inspect/container IDs can be config digests; containerd can
        # report an OCI target. Accept a target only when this archive binds it
        # cryptographically to the exact qualified configuration.
        assert isinstance(ident, str) and ident.startswith("sha256:") and len(ident) == 71
        if ident == config_digest:
            return
        member = archive.getmember("blobs/sha256/" + ident.removeprefix("sha256:"))
        assert member.size < 1024 * 1024
        raw = archive.extractfile(member).read()
        assert "sha256:" + hashlib.sha256(raw).hexdigest() == ident
        target = json.loads(raw)
        assert target["config"]["digest"] == config_digest
    for ident in tested_ids | {comparison["candidateInspectId"]}:
        bind_identity(ident)
receipt = {"passed": True, "version": expected["candidateVersion"], "platform": "linux/amd64",
           "configDigest": config_digest, "inspectId": comparison["candidateInspectId"],
           "exportSha256": export_sha, "entrypoint": ["/init"], "cmd": ["/run.sh"],
           "diffIds": expected["diffIds"], "allExportLayerDiffIdsVerified": True,
           "parentManifest": expected["parentManifest"], "registryManifest": None,
           "testedContainerImageIds": sorted(tested_ids), "exportBoundToTestedImage": True,
           "registryPublished": False, "realAuthenticationTested": False,
           "hardwareRtcFlcTested": False}
(output / "QUALIFIED_CANDIDATE.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
(output / "EXPORT_SHA256.txt").write_text(export_sha + "  " + archive_path.name + "\n", encoding="utf-8")
print(json.dumps({"passed": True, "configDigest": config_digest, "exportSha256": export_sha}))
