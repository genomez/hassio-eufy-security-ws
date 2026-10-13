"""Bind all isolated qualification receipts to the exact private Docker export."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile


BUILD = "/usr/src/app/client/build/"
APPROVED_MODULES = {"eufysecurity", "http/api", "http/station", "p2p/session",
                    "rtc/rtcCommandBridge", "rtc/rtcPacket", "http/pushRequestDiagnostics",
                    "rtc/rtcCameraInfoCoordinator"}
NEW_MODULES = {"http/pushRequestDiagnostics", "rtc/rtcCameraInfoCoordinator"}
SUFFIXES = (".js", ".js.map", ".d.ts")
ALLOWED = {BUILD + module + suffix for module in APPROVED_MODULES for suffix in SUFFIXES}
ADDED = {module + suffix for module in NEW_MODULES for suffix in SUFFIXES}
SOURCE_CHANGES = sorted("src/" + module + ".ts" for module in APPROVED_MODULES)
INHERITED_ASSET_PATHS = {"mqtt/mqtt-eufy.crt", "mqtt/proto/lock.proto",
                         "push/proto/checkin.proto", "push/proto/mcs.proto",
                         "rtc/libsctp/libsctp_0_0_2.js", "rtc/libsctp/libsctp_0_0_2.wasm"}
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
MODULES = {BUILD + module + ".js" for module in APPROVED_MODULES | {
    "push/service", "http/megaApi", "http/megaCrypto"}}
MODULES.update("/usr/src/app/ws/dist/lib/" + file for file in (
    "driver/command.js", "driver/event.js", "driver/state.js", "driver/message_handler.js", "forward.js"))


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def runtime_config(config):
    # Inspect may synthesize empty legacy Docker fields absent from OCI JSON.
    return {key: value for key, value in config.items() if value not in (None, "", False, [], {})}


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
    assert expected["inputSealed"] is True, "Source and fixture contract is not frozen"
    assert re.fullmatch(r"[0-9a-f]{40}", expected["sourceCommit"] or "")
    assert len(expected["diffIds"]) == 11 and all(DIGEST.fullmatch(row) for row in expected["diffIds"])
    assert SHA.fullmatch(expected["parentExportSha256"])
    assert expected["baselineEmissionCount"] == 192 and expected["candidateEmissionCount"] == 198
    assert expected["parentBuildFileCount"] == 198 and expected["candidateBuildFileCount"] == 204
    assets = expected["parentNonEmissionAssets"]
    assert set(assets) == INHERITED_ASSET_PATHS and all(SHA.fullmatch(digest) for digest in assets.values())
    contracts = expected["fixtureReceipts"]
    assert isinstance(contracts, dict) and len(contracts) == 3, "Missing frozen fixture contracts"
    assert contracts["PACKAGED_PUSH_STATUS.json"]["cases"] == 20
    assert contracts["PACKAGED_LOGIN_RETRY.json"]["cases"] == 34
    assert all(name == Path(name).name and name.endswith(".json") for name in contracts)
    assert all(type(contract["cases"]) is int and contract["cases"] > 0 for contract in contracts.values())
    comparison = load(output / "IMAGE_COMPARISON.json")
    startup = load(output / "STARTUP_QUALIFICATION.json")
    compilation = load(output / "COMPILATION_COMPARISON.json")
    fixtures = {name: load(output / name) for name in contracts}
    for receipt in (comparison, startup, compilation, *fixtures.values()):
        assert receipt["passed"] is True
    for flag in ("baselineEmissionsMatchParent", "productionTypecheckPassed",
                 "networkDisabledDuringCompilation", "dependenciesFromParent", "compilerStageOnly"):
        assert compilation[flag] is True
    assert compilation["compilerVersion"] == "5.9.3"
    assert compilation["parentBuildFileCount"] == 198 and compilation["candidateBuildFileCount"] == 204
    assert compilation["inheritedNonEmissionAssetCount"] == 6
    assert compilation["parentNonEmissionAssetsMatchPinned"] is True
    assert compilation["parentNonEmissionAssets"] == assets
    for receipt in (comparison, compilation):
        assert receipt["parentManifest"] == expected["parentManifest"]
        assert receipt["parentConfig"] == expected["parentConfig"]
        assert receipt["candidateVersion"] == expected["candidateVersion"]
        assert receipt["sourceCommit"] == expected["sourceCommit"]
    assert comparison["parentFilesystemLayersRetained"] is True
    assert comparison["addedFilesystemLayers"] == 1
    assert comparison["onlyRuntimeConfigChanges"] == ["Labels.org.opencontainers.image.version"]
    assert comparison["registryPublished"] is False
    assert compilation["sourceChanges"] == SOURCE_CHANGES
    assert compilation["sourceHashes"] == expected["sourceHashes"]
    for variant in ("baseline", "candidate"):
        assert len(expected["sourceHashes"][variant]) > 100
        assert all(SHA.fullmatch(digest) for digest in expected["sourceHashes"][variant].values())
    source_baseline, source_candidate = expected["sourceHashes"]["baseline"], expected["sourceHashes"]["candidate"]
    assert set(source_candidate) == set(source_baseline) | {"src/" + module + ".ts" for module in NEW_MODULES}
    assert sorted(file for file in source_candidate if source_baseline.get(file) != source_candidate[file]) == SOURCE_CHANGES
    assert compilation["launcherSha256"] == expected["launcherSha256"]
    baseline, candidate = compilation["baselineEmissions"], compilation["candidateEmissions"]
    assert len(baseline) == compilation["baselineEmissionCount"] == 192
    assert len(candidate) == compilation["candidateEmissionCount"] == 198
    assert not set(assets) & set(candidate), "Inherited assets overlap compiler emissions"
    assert set(candidate) == set(baseline) | ADDED and not set(baseline) & ADDED
    assert sorted(compilation["addedFiles"]) == sorted(ADDED)
    assert all(SHA.fullmatch(digest) for digest in (*baseline.values(), *candidate.values()))
    assert all(canonical(name) == "/" + name for name in candidate)
    emitted_changes = {BUILD + name: {"baselineSha256": baseline.get(name), "candidateSha256": candidate[name]}
                       for name in candidate if baseline.get(name) != candidate[name]}
    assert emitted_changes == compilation["changedFiles"]
    assert emitted_changes and emitted_changes.keys() <= ALLOWED
    assert {BUILD + module + ".js" for module in APPROVED_MODULES} <= emitted_changes.keys()
    assert {BUILD + name for name in ADDED} <= emitted_changes.keys()
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
    module_hashes = {}
    for name, receipt in fixtures.items():
        contract = contracts[name]
        assert receipt["testedImageId"] == receipt["imageId"]
        assert receipt["networkMode"] == "none" and receipt["blockedOperations"] == 0
        assert receipt["processGuardEnabled"] is True and receipt["nativeRTCStubbed"] is True
        assert receipt["actualCompiledSDK"] is True and receipt["productTranspilation"] is False
        assert receipt["exitCode"] == 0 and receipt["oomKilled"] is False
        assert receipt["forcedTermination"] is False
        assert receipt["numPassed"] == receipt["cases"] == contract["cases"]
        if "actualCompiledWebSocket" in contract:
            assert receipt["actualCompiledWebSocket"] is contract["actualCompiledWebSocket"]
        tested_ids.add(receipt["testedImageId"])
        rows = {row["file"]: row["sha256"] for row in receipt["moduleHashes"]}
        assert len(receipt["moduleHashes"]) == len(rows) == len(contract["modules"])
        assert set(rows) == set(contract["modules"]) and set(rows) <= MODULES
        assert all(SHA.fullmatch(digest) for digest in rows.values())
        for file, digest in rows.items():
            assert file not in module_hashes or module_hashes[file] == digest, "Fixtures tested different module bytes"
            module_hashes[file] = digest
    assert len(tested_ids) == 1 and module_hashes.keys() == MODULES
    with archive_path.open("rb") as handle:
        export_sha = hashlib.file_digest(handle, "sha256").hexdigest()
    with tarfile.open(archive_path, "r:*") as archive:
        names = archive.getnames()
        assert len(names) == len(set(names)), "Duplicate export archive member"
        manifests = json.load(archive.extractfile("manifest.json"))
        assert len(manifests) == 1
        manifest = manifests[0]
        config_bytes = archive.extractfile(manifest["Config"]).read()
        config_digest = "sha256:" + hashlib.sha256(config_bytes).hexdigest()
        config = json.loads(config_bytes)
        assert config["architecture"] == "amd64" and config["os"] == "linux"
        assert runtime_config(config["config"]) == comparison["runtimeConfig"], "Export runtime config differs from inspected candidate"
        assert config["config"]["Entrypoint"] == ["/init"] and config["config"]["Cmd"] == ["/run.sh"]
        assert config["config"]["Labels"]["org.opencontainers.image.version"] == expected["candidateVersion"]
        diffs = config["rootfs"]["diff_ids"]
        assert diffs == comparison["diffIds"] and diffs[:-1] == expected["diffIds"]
        assert len(manifest["Layers"]) == len(diffs) == 12
        for layer, digest in zip(manifest["Layers"], diffs):
            assert "sha256:" + hashlib.file_digest(archive.extractfile(layer), "sha256").hexdigest() == digest
        # Reconstruct parent targets from the cryptographically retained layers.
        retained_targets = {BUILD + name for name in set(baseline) | set(assets)} | (MODULES - {BUILD + name for name in ADDED}) | {"/run.sh"}
        retained_hashes = {}
        retained_build = {}
        for layer in manifest["Layers"][:-1]:
            with tarfile.open(fileobj=archive.extractfile(layer), mode="r|*") as filesystem:
                for member in filesystem:
                    file = canonical(member.name)
                    basename = PurePosixPath(file).name
                    if file in retained_targets:
                        assert member.isfile(), "Expected retained target is not a regular file"
                        retained_hashes[file] = hashlib.file_digest(filesystem.extractfile(member), "sha256").hexdigest()
                    if file.startswith(BUILD) and not basename.startswith(".wh."):
                        assert member.isfile() or member.isdir(), "Unexpected parent build entry type"
                        if member.isfile():
                            digest = retained_hashes.get(file)
                            if digest is None:
                                digest = hashlib.file_digest(filesystem.extractfile(member), "sha256").hexdigest()
                            retained_build[file.removeprefix(BUILD)] = digest
                    if basename.startswith(".wh."):
                        parent = PurePosixPath(file).parent
                        removed = str(parent / basename.removeprefix(".wh."))
                        if basename == ".wh..wh..opq":
                            assert not any(str(parent) == target or target.startswith(str(parent).rstrip("/") + "/")
                                           for target in retained_targets), "Retained target directory was made opaque"
                        else:
                            assert not any(target == removed or target.startswith(removed + "/") for target in retained_targets), "Retained target was whiteouted"
                        for name in tuple(retained_build):
                            target = BUILD + name
                            opaque_removed = basename == ".wh..wh..opq" and target.startswith(str(parent).rstrip("/") + "/")
                            if opaque_removed or target == removed or target.startswith(removed + "/"):
                                del retained_build[name]
        assert retained_hashes.keys() == retained_targets
        assert retained_hashes["/run.sh"] == expected["launcherSha256"]
        assert {name: retained_hashes[BUILD + name] for name in baseline} == baseline
        retained_assets = {name: retained_hashes[BUILD + name] for name in assets}
        assert retained_assets == assets, "Inherited non-emission asset bytes differ from pinned parent"
        assert len(retained_build) == 198 and retained_build == {**baseline, **assets}, "Parent complete build inventory mismatch"
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
                    assert file in directory_allowlist and member.mode == 0o755
                    continue
                assert member.isfile() and file in emitted_changes, "Unexpected final-layer content"
                assert member.mode == 0o644
                raw = delta.extractfile(member).read()
                digest = hashlib.sha256(raw).hexdigest()
                assert digest == emitted_changes[file]["candidateSha256"]
                if file.endswith(".js.map"):
                    assert "sourcesContent" not in json.loads(raw), "Source content leaked into a map"
                delta_files[file] = digest
        assert delta_files.keys() == emitted_changes.keys(), "Missing compiled delta"
        final_modules = {file: delta_files[file] if file in delta_files else retained_hashes[file] for file in MODULES}
        assert final_modules == module_hashes, "Fixture modules do not match the export"
        final_emissions = {name: delta_files.get(BUILD + name, retained_hashes.get(BUILD + name)) for name in candidate}
        assert final_emissions == candidate, "Final production emissions differ from compiler receipt"
        final_build = {**retained_build, **{file.removeprefix(BUILD): digest for file, digest in delta_files.items()}}
        assert len(final_build) == 204 and final_build == {**candidate, **assets}, "Final complete build inventory mismatch"
        assert {name: final_build[name] for name in assets} == retained_assets, "Inherited asset changed in candidate"

        def bind_identity(ident):
            assert isinstance(ident, str) and DIGEST.fullmatch(ident)
            if ident == config_digest:
                return
            member = archive.getmember("blobs/sha256/" + ident.removeprefix("sha256:"))
            assert member.isfile() and member.size < 1024 * 1024
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
               "baselineEmissionCount": 192, "candidateEmissionCount": 198,
               "parentBuildFileCount": 198, "candidateBuildFileCount": 204,
               "inheritedNonEmissionAssetCount": 6, "parentNonEmissionAssets": retained_assets,
               "inheritedNonEmissionAssetsPreserved": True, "allBuildFileBytesVerified": True,
               "allProductionEmissionBytesVerified": True, "changedCompiledFiles": delta_files,
               "launcherSha256": expected["launcherSha256"], "testedModuleHashes": module_hashes,
               "sourceCommit": expected["sourceCommit"], "sourceHashes": expected["sourceHashes"],
               "parentManifest": expected["parentManifest"], "parentConfig": expected["parentConfig"],
               "parentExportSha256": expected["parentExportSha256"], "registryManifest": None,
               "testedContainerImageIds": sorted(tested_ids), "exportBoundToTestedImage": True,
               "fixtureCasesPassed": {name: contract["cases"] for name, contract in contracts.items()},
               "packagedPushStatusCasesPassed": 20, "packagedLoginRetryCasesPassed": 34,
               "packagedStartupCoordinationCasesPassed": contracts["PACKAGED_STARTUP_COORDINATION.json"]["cases"],
               "registryPublished": False, "realAuthenticationTested": False, "hardwareRtcFlcTested": False}
    (output / "QUALIFIED_CANDIDATE.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    (output / "EXPORT_SHA256.txt").write_text(export_sha + "  " + archive_path.name + "\n", encoding="utf-8")
    print(json.dumps({"passed": True, "configDigest": config_digest, "exportSha256": export_sha,
                      "changedFiles": sorted(delta_files)}))


if __name__ == "__main__":
    main()
