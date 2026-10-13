"""Verify the exact qualified image through the registry API without rebuilding it."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zlib

REPOSITORY = "genomez/eufy-security-ws-rc3-login-retry-amd64"
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
ACCEPT = "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json"
GZIP_TYPES = {"application/vnd.docker.image.rootfs.diff.tar.gzip", "application/vnd.oci.image.layer.v1.tar+gzip"}
TAR_TYPES = {"application/vnd.docker.image.rootfs.diff.tar", "application/vnd.oci.image.layer.v1.tar"}


def require(condition, marker):
    if not condition:
        raise ValueError(marker)


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    """Keep registry credentials out of redirected blob requests."""
    def redirect_request(self, request, response, code, message, headers, new_url):
        require(urllib.parse.urlparse(new_url).scheme == "https", "non_https_redirect")
        redirected = super().redirect_request(request, response, code, message, headers, new_url)
        if redirected is not None:
            redirected.remove_header("Authorization")
        return redirected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("authenticated", "anonymous", "preflight"))
    parser.add_argument("--expected-manifest")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    expected = json.loads((Path(__file__).parent / "expected-image.json").read_text(encoding="utf-8"))
    version = expected["version"]
    require(version == "3.0.18-regional-rtc-rc3-login-retry.4", "unexpected_version")
    require(expected["platform"] == "linux/amd64", "unexpected_platform")
    require(len(expected["diff_ids"]) == 12, "unexpected_layer_count")
    require(DIGEST.fullmatch(expected["image_id"]) is not None, "invalid_expected_config")
    require(all(DIGEST.fullmatch(value) for value in expected["diff_ids"]), "invalid_expected_diff_ids")
    if args.expected_manifest:
        require(DIGEST.fullmatch(args.expected_manifest) is not None, "invalid_expected_manifest")
    output = args.output or Path("registry-preflight.json" if args.mode == "preflight" else "registry-identity.json")
    opener = urllib.request.build_opener(SafeRedirect())
    token_headers = {}
    if args.mode != "anonymous":
        credential = os.environ["GITHUB_ACTOR"] + ":" + os.environ["GITHUB_TOKEN"]
        token_headers["Authorization"] = "Basic " + base64.b64encode(credential.encode()).decode()
        del credential
    query = urllib.parse.urlencode({"service": "ghcr.io", "scope": "repository:" + REPOSITORY + ":pull"})
    with opener.open(urllib.request.Request("https://ghcr.io/token?" + query, headers=token_headers), timeout=60) as response:
        token_body = json.loads(response.read(1024 * 1024 + 1))
    bearer = token_body.get("token", token_body.get("access_token"))
    require(isinstance(bearer, str) and bool(bearer), "missing_registry_token")
    del token_body, token_headers
    headers = {"Authorization": "Bearer " + bearer}
    del bearer

    def fetch(path, accept=None):
        request_headers = dict(headers)
        if accept:
            request_headers["Accept"] = accept
        return opener.open(urllib.request.Request("https://ghcr.io/v2/" + REPOSITORY + "/" + path, headers=request_headers), timeout=120)

    reference = args.expected_manifest or version
    try:
        response = fetch("manifests/" + reference, ACCEPT)
    except urllib.error.HTTPError as error:
        if args.mode == "preflight" and not args.expected_manifest and error.code == 404:
            receipt = {"mode": args.mode, "exists": False, "image": "ghcr.io/" + REPOSITORY + ":" + version,
                       "tag_absent_verified": True, "container_started": False, "rebuilt": False}
            output.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
            print(json.dumps({"mode": args.mode, "exists": False, "tag_absent_verified": True}))
            return
        raise
    with response:
        manifest_bytes = response.read(4 * 1024 * 1024 + 1)
        require(len(manifest_bytes) <= 4 * 1024 * 1024, "manifest_too_large")
        digest = "sha256:" + hashlib.sha256(manifest_bytes).hexdigest()
        require(response.headers.get("Docker-Content-Digest") == digest, "manifest_header_mismatch")
    if args.expected_manifest:
        require(digest == args.expected_manifest, "immutable_manifest_mismatch")
    manifest = json.loads(manifest_bytes)
    require(manifest.get("schemaVersion") == 2 and "config" in manifest and "manifests" not in manifest, "not_single_image_manifest")
    require(manifest["config"]["digest"] == expected["image_id"], "config_identity_mismatch")
    require(type(manifest["config"]["size"]) is int and 0 < manifest["config"]["size"] <= 4 * 1024 * 1024, "invalid_config_size")
    with fetch("blobs/" + expected["image_id"]) as response:
        config_bytes = response.read(4 * 1024 * 1024 + 1)
    require(len(config_bytes) == manifest["config"]["size"], "config_size_mismatch")
    require("sha256:" + hashlib.sha256(config_bytes).hexdigest() == expected["image_id"], "config_hash_mismatch")
    config = json.loads(config_bytes)
    require(config["os"] == "linux" and config["architecture"] == "amd64", "platform_mismatch")
    require(config["rootfs"]["type"] == "layers" and config["rootfs"]["diff_ids"] == expected["diff_ids"], "diff_ids_mismatch")
    require(config["config"]["Entrypoint"] == expected["entrypoint"] == ["/init"], "entrypoint_mismatch")
    require(config["config"]["Cmd"] == expected["cmd"] == ["/run.sh"], "command_mismatch")
    require(config["config"]["Labels"]["org.opencontainers.image.version"] == version, "version_label_mismatch")
    require(len(manifest["layers"]) == len(expected["diff_ids"]) == 12, "layer_count_mismatch")
    layers = []
    for layer, diff_id in zip(manifest["layers"], expected["diff_ids"]):
        require(DIGEST.fullmatch(layer["digest"]) is not None, "invalid_layer_digest")
        require(type(layer["size"]) is int and layer["size"] > 0, "invalid_layer_size")
        media_type = layer["mediaType"]
        require(media_type in GZIP_TYPES | TAR_TYPES, "unsupported_layer_media_type")
        compressed_hash = hashlib.sha256()
        unpacked_hash = hashlib.sha256()
        decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS) if media_type in GZIP_TYPES else None
        compressed_size = 0
        with fetch("blobs/" + layer["digest"]) as response:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                compressed_size += len(chunk)
                require(compressed_size <= layer["size"], "layer_exceeds_declared_size")
                compressed_hash.update(chunk)
                unpacked_hash.update(decompressor.decompress(chunk) if decompressor else chunk)
        if decompressor:
            unpacked_hash.update(decompressor.flush())
            require(decompressor.eof and not decompressor.unused_data and not decompressor.unconsumed_tail, "invalid_gzip_layer")
        require(compressed_size == layer["size"], "layer_size_mismatch")
        require("sha256:" + compressed_hash.hexdigest() == layer["digest"], "compressed_layer_hash_mismatch")
        require("sha256:" + unpacked_hash.hexdigest() == diff_id, "layer_diff_id_mismatch")
        layers.append({"digest": layer["digest"], "size": layer["size"], "diff_id": diff_id, "media_type": media_type})
    receipt = {"mode": args.mode, "exists": True, "image": "ghcr.io/" + REPOSITORY + ":" + version,
               "read_reference": reference, "manifest_digest": digest, "image_id": expected["image_id"],
               "platform": "linux/amd64", "entrypoint": ["/init"], "cmd": ["/run.sh"], "layers": layers,
               "expected_export_sha256": expected["export_sha256"], "manifest_config_all_layers_verified": True,
               "container_started": False, "rebuilt": False}
    output.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: receipt[key] for key in ("mode", "image", "manifest_digest", "image_id", "manifest_config_all_layers_verified")}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never print exception text, request URLs, response bodies or authentication headers.
        print(json.dumps({"passed": False, "failure": "registry_verification_failed", "error_type": type(error).__name__}), file=sys.stderr)
        sys.exit(1)
