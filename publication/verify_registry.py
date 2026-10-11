"""Verify the sealed amd64 image directly through the OCI distribution API."""
import base64
import gzip
import hashlib
import json
import os
import sys
import urllib.parse
import urllib.request

MODE = sys.argv[1]
assert MODE in ("authenticated", "anonymous")
REPOSITORY = "genomez/eufy-security-ws-rc3-login-retry-amd64"
VERSION = "3.0.18-regional-rtc-rc3-login-retry.1"
EXPECTED = json.load(open("publication/expected-image.json", encoding="utf-8"))
headers = {}
if MODE == "authenticated":
    value = os.environ["GITHUB_ACTOR"] + ":" + os.environ["GH_TOKEN"]
    headers["Authorization"] = "Basic " + base64.b64encode(value.encode()).decode()
query = urllib.parse.urlencode({"service": "ghcr.io", "scope": "repository:" + REPOSITORY + ":pull"})
with urllib.request.urlopen(urllib.request.Request("https://ghcr.io/token?" + query, headers=headers), timeout=60) as response:
    bearer = json.load(response)["token"]
headers = {"Authorization": "Bearer " + bearer}

def fetch(path, accept=None):
    request_headers = dict(headers)
    if accept:
        request_headers["Accept"] = accept
    return urllib.request.urlopen(urllib.request.Request("https://ghcr.io/v2/" + REPOSITORY + "/" + path, headers=request_headers), timeout=120)

with fetch("manifests/" + VERSION, "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json") as response:
    manifest_bytes = response.read()
    digest = "sha256:" + hashlib.sha256(manifest_bytes).hexdigest()
    assert response.headers["Docker-Content-Digest"] == digest
manifest = json.loads(manifest_bytes)
assert manifest["schemaVersion"] == 2 and "config" in manifest
assert manifest["config"]["digest"] == EXPECTED["image_id"]
with fetch("blobs/" + EXPECTED["image_id"]) as response:
    config_bytes = response.read()
assert "sha256:" + hashlib.sha256(config_bytes).hexdigest() == EXPECTED["image_id"]
config = json.loads(config_bytes)
assert config["os"] == "linux" and config["architecture"] == "amd64"
assert config["rootfs"]["diff_ids"] == EXPECTED["diff_ids"]
assert config["config"]["Cmd"] == EXPECTED["cmd"]
assert config["config"]["Labels"]["org.opencontainers.image.version"] == VERSION
assert len(manifest["layers"]) == len(EXPECTED["diff_ids"]) == 9
layers = []
for layer, diff_id in zip(manifest["layers"], EXPECTED["diff_ids"]):
    with fetch("blobs/" + layer["digest"]) as response:
        compressed = response.read()
    assert len(compressed) == layer["size"]
    assert "sha256:" + hashlib.sha256(compressed).hexdigest() == layer["digest"]
    unpacked = gzip.decompress(compressed) if layer["mediaType"].endswith("gzip") else compressed
    assert "sha256:" + hashlib.sha256(unpacked).hexdigest() == diff_id
    layers.append({"digest": layer["digest"], "size": layer["size"], "diff_id": diff_id})
receipt = {"mode": MODE, "image": "ghcr.io/" + REPOSITORY + ":" + VERSION, "manifest_digest": digest,
           "image_id": EXPECTED["image_id"], "platform": "linux/amd64", "layers": layers,
           "manifest_config_all_layers_verified": True, "container_started": False, "rebuilt": False}
with open("registry-identity.json", "w", encoding="utf-8") as output:
    json.dump(receipt, output, indent=2)
print(json.dumps({key: receipt[key] for key in ("mode", "image", "manifest_digest", "image_id", "manifest_config_all_layers_verified")}))
