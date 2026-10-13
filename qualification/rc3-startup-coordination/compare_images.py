"""Compare local daemon image metadata without executing either image."""
import argparse
import copy
import json
from pathlib import Path
import re
import subprocess


def runtime_config(config):
    # Inspect may synthesize empty legacy Docker fields absent from OCI JSON.
    return {key: value for key, value in config.items() if value not in (None, "", False, [], {})}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--original", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    expected = json.loads((Path(__file__).parent / "EXPECTED_PARENT.json").read_text(encoding="utf-8"))
    assert expected["inputSealed"] is True, "Source and fixture contract is not frozen"
    assert re.fullmatch(r"[0-9a-f]{40}", expected["sourceCommit"] or "")
    assert len(expected["diffIds"]) == 11

    def inspect(image):
        result = subprocess.run(["docker", "image", "inspect", image], check=True,
                                capture_output=True, encoding="utf-8", timeout=30)
        rows = json.loads(result.stdout)
        assert len(rows) == 1
        return rows[0]

    old, new = inspect(args.original), inspect(args.candidate)
    assert old["Architecture"] == new["Architecture"] == "amd64"
    assert old["Os"] == new["Os"] == "linux"
    assert old["Config"]["Entrypoint"] == new["Config"]["Entrypoint"] == ["/init"]
    assert old["Config"]["Cmd"] == new["Config"]["Cmd"] == ["/run.sh"]
    assert old["RootFS"]["Layers"] == expected["diffIds"]
    assert old["Id"] in (expected["parentConfig"], expected["parentManifest"]), "Unexpected parent identity"
    assert new["RootFS"]["Layers"][:-1] == expected["diffIds"]
    assert len(new["RootFS"]["Layers"]) == 12
    assert old["Config"]["Labels"]["org.opencontainers.image.version"] == expected["parentVersion"]
    assert new["Config"]["Labels"]["org.opencontainers.image.version"] == expected["candidateVersion"]
    old_config = copy.deepcopy(old["Config"])
    old_config["Labels"]["org.opencontainers.image.version"] = expected["candidateVersion"]
    assert old_config == new["Config"], "Unexpected runtime configuration difference"
    assert expected["parentRepository"] + "@" + expected["parentManifest"] in old.get("RepoDigests", [])
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    receipt = {"passed": True, "parentManifest": expected["parentManifest"],
               "parentConfig": expected["parentConfig"], "originalInspectId": old["Id"],
               "candidateInspectId": new["Id"], "candidateVersion": expected["candidateVersion"],
               "sourceCommit": expected["sourceCommit"], "runtimeConfig": runtime_config(new["Config"]),
               "entrypoint": new["Config"]["Entrypoint"], "cmd": new["Config"]["Cmd"],
               "diffIds": new["RootFS"]["Layers"], "parentFilesystemLayersRetained": True,
               "addedFilesystemLayers": 1,
               "onlyRuntimeConfigChanges": ["Labels.org.opencontainers.image.version"],
               "registryPublished": False}
    (output / "IMAGE_COMPARISON.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": True, "parentFilesystemLayersRetained": True, "addedFilesystemLayers": 1}))


if __name__ == "__main__":
    main()
