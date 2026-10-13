"""Validate a loaded export without creating or starting a container."""
import hashlib
import json
from pathlib import Path
import re
import tarfile

expected = json.loads((Path(__file__).parent / "expected-image.json").read_text())
image = json.loads(Path("loaded-image.json").read_text())[0]
assert image["Os"] == "linux" and image["Architecture"] == "amd64"
assert image["RootFS"]["Layers"] == expected["diff_ids"]
assert image["Config"]["Entrypoint"] == expected["entrypoint"] == ["/init"]
assert image["Config"]["Cmd"] == expected["cmd"] == ["/run.sh"]
assert image["Config"]["Labels"]["org.opencontainers.image.version"] == expected["version"]
identity = image["Id"]
assert re.fullmatch(r"sha256:[0-9a-f]{64}", identity)
if identity != expected["image_id"]:
    with tarfile.open("qualified-export/candidate-image.tar.gz", "r:gz") as archive:
        raw = archive.extractfile("blobs/sha256/" + identity.removeprefix("sha256:")).read()
        assert "sha256:" + hashlib.sha256(raw).hexdigest() == identity
        assert json.loads(raw)["config"]["digest"] == expected["image_id"]
Path("loaded-image-verification.json").write_text(json.dumps({
    "passed": True, "inspect_id": identity, "config_digest": expected["image_id"],
    "platform": "linux/amd64", "filesystem_layers": len(expected["diff_ids"]),
    "entrypoint": ["/init"], "cmd": ["/run.sh"],
    "container_started": False, "rebuilt": False,
}, indent=2) + "\n")
