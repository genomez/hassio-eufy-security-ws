"""Assert a configuration-only derivative; do not execute either image."""
import argparse
import copy
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--original", required=True)
parser.add_argument("--candidate", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
expected = json.loads((Path(__file__).parent / "EXPECTED_PARENT.json").read_text())

def inspect(image):
    result = subprocess.run(["docker", "image", "inspect", image], check=True,
                            capture_output=True, encoding="utf-8", timeout=30)
    rows = json.loads(result.stdout)
    assert len(rows) == 1
    return rows[0]

old, new = inspect(args.original), inspect(args.candidate)
assert old["Architecture"] == new["Architecture"] == "amd64"
assert old["Os"] == new["Os"] == "linux"
assert old["Config"].get("Entrypoint") in (None, [])
assert new["Config"]["Entrypoint"] == ["/init"]
assert old["Config"]["Cmd"] == new["Config"]["Cmd"] == ["/run.sh"]
assert old["RootFS"]["Layers"] == new["RootFS"]["Layers"] == expected["diffIds"]
assert old["Config"]["Labels"]["org.opencontainers.image.version"] == expected["parentVersion"]
assert new["Config"]["Labels"]["org.opencontainers.image.version"] == expected["candidateVersion"]
old_config = copy.deepcopy(old["Config"])
old_config["Entrypoint"] = ["/init"]
old_config["Labels"]["org.opencontainers.image.version"] = expected["candidateVersion"]
assert old_config == new["Config"], "Unexpected runtime configuration difference"
assert any(value.endswith("@" + expected["parentManifest"]) for value in old.get("RepoDigests", []))
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
receipt = {"passed": True, "parentManifest": expected["parentManifest"],
           "parentConfig": expected["parentConfig"], "originalInspectId": old["Id"],
           "candidateInspectId": new["Id"], "candidateVersion": expected["candidateVersion"],
           "entrypoint": new["Config"]["Entrypoint"], "cmd": new["Config"]["Cmd"],
           "diffIds": new["RootFS"]["Layers"], "filesystemLayersIdentical": True,
           "onlyRuntimeConfigChanges": ["Entrypoint", "Labels.org.opencontainers.image.version"],
           "registryPublished": False}
(output / "IMAGE_COMPARISON.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"passed": True, "filesystemLayersIdentical": True, "entrypoint": ["/init"]}))
