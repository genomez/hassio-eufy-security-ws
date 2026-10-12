"""Bind qualified receipts to the exact Docker export, without running it."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile


ALLOWED = {"/usr/src/app/client/build/" + module + suffix
           for module in ("eufysecurity", "push/service")
           for suffix in (".js", ".js.map", ".d.ts")}
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
MODULES = {"/usr/src/app/client/build/" + file for file in (
    "eufysecurity.js", "push/service.js", "http/megaApi.js", "http/megaCrypto.js")}
MODULES.update("/usr/src/app/ws/dist/lib/" + file for file in (
    "driver/command.js", "driver/event.js", "driver/state.js", "driver/message_handler.js", "forward.js"))


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def canonical(name):
    value = name.removeprefix("./").removeprefix("/").rstrip("/")
    assert ".." not in PurePosixPath(value).parts and "\\" not in value
    assert value in ("", ".") or str(PurePosixPath(value)) == value
    return "/" + value if value not in ("", ".") else "/"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--export", required=True)
    parser.add_argument("--results", required=True)
    args = parser.parse_args()
    archive_path, output = Path(args.export), Path(args.results)
    expected = load(Path(__file__).parent / "EXPECTED_PARENT.json")
    comparison = load(output / "IMAGE_COMPARISON.json")
    startup = load(output / "STARTUP_QUALIFICATION.json")
    compilation = load(output / "COMPILATION_COMPARISON.json")
    push = load(output / "PACKAGED_PUSH_STATUS.json")
    retry = load(output / "PACKAGED_LOGIN_RETRY.json")
    for receipt in (comparison, startup, compilation, push, retry):
        assert receipt["passed"] is True
    assert compilation["baselineEmissionsMatchParent"] is True
    assert compilation["productionTypecheckPassed"] is True
    assert compilation["networkDisabledDuringCompilation"] is True
    assert compilation["dependenciesFromParent"] is True
    assert compilation["compilerVersion"] == "5.9.3"
    for receipt in (comparison, compilation):
        assert receipt["parentManifest"] == expected["parentManifest"]
        assert receipt["parentConfig"] == expected["parentConfig"]
        assert receipt["candidateVersion"] == expected["candidateVersion"]
    assert compilation["sourceChanges"] == ["src/eufysecurity.ts", "src/push/service.ts"]
    for variant in ("baseline", "candidate"):
        for file, digest in expected["sourceHashes"][variant].items():
            assert compilation["sourceHashes"][variant][file] == digest
    assert compilation["launcherSha256"] == expected["launcherSha256"]
    baseline, candidate = compilation["baselineEmissions"], compilation["candidateEmissions"]
    assert baseline.keys() == candidate.keys()
    assert len(baseline) == compilation["emittedFileCount"] > 100
    emitted_changes = {"/usr/src/app/client/build/" + name:
                       {"baselineSha256": baseline[name], "candidateSha256": candidate[name]}
                       for name in baseline if baseline[name] != candidate[name]}
    assert emitted_changes == compilation["changedFiles"]
    assert emitted_changes and emitted_changes.keys() <= ALLOWED
    assert {"/usr/src/app/client/build/eufysecurity.js",
            "/usr/src/app/client/build/push/service.js"} <= emitted_changes.keys()
    for pair in emitted_changes.values():
        assert all(SHA.fullmatch(digest) for digest in pair.values())
    assert len(startup["cases"]) == 4
    assert {case["case"] for case in startup["cases"]} == {
        "parent-empty", "corrected-empty", "corrected-synthetic", "corrected-route-unavailable"}
    for case in startup["cases"]:
        assert case["passed"] is True and case["exitCode"] == 0
        assert case["oomKilled"] is False and case["forcedTermination"] is False
        assert case["networkMode"] == "none"
        assert case["defaultPath"] == "/init" and case["defaultArgs"] == ["/run.sh"]
        assert case["rtcBindingFixtureOverride"] is False
        assert "blockedOperation" not in case["trace"]
        if case["case"] == "parent-empty":
            assert case["imageId"] in (expected["parentConfig"], expected["parentManifest"])
    assert comparison["originalInspectId"] in (expected["parentConfig"], expected["parentManifest"])
    tested_ids = {case["imageId"] for case in startup["cases"] if case["case"].startswith("corrected-")}
    assert len(tested_ids) == 1
    for receipt in (push, retry):
        assert receipt["testedImageId"] == receipt["imageId"]
        assert receipt["networkMode"] == "none" and receipt["blockedOperations"] == 0
        assert receipt["processGuardEnabled"] is True and receipt["nativeRTCStubbed"] is True
        assert receipt["actualCompiledSDK"] is True and receipt["productTranspilation"] is False
        assert receipt["exitCode"] == 0 and receipt["oomKilled"] is False
        assert receipt["forcedTermination"] is False
        tested_ids.add(receipt["testedImageId"])
    assert len(tested_ids) == 1
    assert push["numPassed"] == push["cases"] == 20
    assert retry["numPassed"] == retry["cases"] == 34
    assert push["actualCompiledWebSocket"] is True
    module_hashes = {row["file"]: row["sha256"] for row in push["moduleHashes"]}
    assert len(push["moduleHashes"]) == len(module_hashes) == 9 and module_hashes.keys() == MODULES
    assert all(SHA.fullmatch(digest) for digest in module_hashes.values())
    assert len(retry["moduleHashes"]) == 9
    assert {row["file"]: row["sha256"] for row in retry["moduleHashes"]} == module_hashes
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
        diffs = config["rootfs"]["diff_ids"]
        assert diffs == comparison["diffIds"]
        assert diffs[:-1] == expected["diffIds"]
        assert len(manifest["Layers"]) == len(expected["diffIds"]) + 1 == len(diffs)
        for layer, digest in zip(manifest["Layers"], diffs):
            assert "sha256:" + hashlib.file_digest(archive.extractfile(layer), "sha256").hexdigest() == digest
        # Bind actual installed module hashes and the retained launcher, rather
        # than trusting a receipt's filename or its success Boolean alone.
        retained_targets = MODULES | {"/run.sh"}
        retained_hashes = {}
        for layer in manifest["Layers"][:-1]:
            with tarfile.open(fileobj=archive.extractfile(layer), mode="r|*") as filesystem:
                for member in filesystem:
                    file = canonical(member.name)
                    if file in retained_targets:
                        assert member.isfile(), "Expected retained module is not a regular file"
                        retained_hashes[file] = hashlib.file_digest(filesystem.extractfile(member), "sha256").hexdigest()
                    basename = PurePosixPath(file).name
                    if basename.startswith(".wh."):
                        removed = str(PurePosixPath(file).parent / basename.removeprefix(".wh."))
                        assert removed not in retained_targets, "Retained module was whiteouted"
        assert retained_hashes.keys() == retained_targets
        assert retained_hashes["/run.sh"] == expected["launcherSha256"]
        directory_allowlist = {"/"}
        for file in emitted_changes:
            directory_allowlist.update(str(parent) for parent in PurePosixPath(file).parents)
        delta_bytes = archive.extractfile(manifest["Layers"][-1]).read()
        delta_files = {}
        with tarfile.open(fileobj=io.BytesIO(delta_bytes), mode="r:*") as delta:
            seen = set()
            for member in delta:
                file = canonical(member.name)
                assert file not in seen, "Duplicate delta entry"
                seen.add(file)
                assert member.uid == member.gid == 0
                if member.isdir():
                    assert file in directory_allowlist
                    assert member.mode & 0o777 == 0o755
                    continue
                assert member.isfile() and file in emitted_changes, "Unexpected final-layer content"
                assert member.mode & 0o777 == 0o644
                digest = hashlib.sha256(delta.extractfile(member).read()).hexdigest()
                assert digest == emitted_changes[file]["candidateSha256"]
                delta_files[file] = digest
        assert delta_files.keys() == emitted_changes.keys(), "Missing compiled delta"
        final_modules = {file: delta_files.get(file, retained_hashes[file]) for file in MODULES}
        assert final_modules == module_hashes, "Fixture modules do not match the export"

        def bind_identity(ident):
            assert isinstance(ident, str) and DIGEST.fullmatch(ident)
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
               "diffIds": diffs, "allExportLayerDiffIdsVerified": True,
               "parentFilesystemLayersRetained": True, "addedFilesystemLayers": 1,
               "changedCompiledFiles": delta_files, "launcherSha256": expected["launcherSha256"],
               "testedModuleHashes": module_hashes,
               "sourceCommit": expected["sourceCommit"], "sourceHashes": expected["sourceHashes"],
               "parentManifest": expected["parentManifest"], "registryManifest": None,
               "testedContainerImageIds": sorted(tested_ids), "exportBoundToTestedImage": True,
               "packagedPushStatusCasesPassed": 20, "packagedLoginRetryCasesPassed": 34,
               "registryPublished": False, "realAuthenticationTested": False,
               "hardwareRtcFlcTested": False}
    (output / "QUALIFIED_CANDIDATE.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    (output / "EXPORT_SHA256.txt").write_text(export_sha + "  " + archive_path.name + "\n", encoding="utf-8")
    print(json.dumps({"passed": True, "configDigest": config_digest, "exportSha256": export_sha,
                      "changedFiles": sorted(delta_files)}))


if __name__ == "__main__":
    main()
