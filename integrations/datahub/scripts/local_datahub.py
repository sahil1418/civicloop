"""Run the pinned official DataHub quickstart in an isolated local Compose project."""

import argparse
import hashlib
import os
from pathlib import Path
import secrets
import subprocess
import urllib.request

import yaml

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / ".local"
VERSION = "v1.8.0"
URL = f"https://raw.githubusercontent.com/datahub-project/datahub/{VERSION}/docker/quickstart/docker-compose.quickstart-profile.yml"
UPSTREAM_SHA256 = "4342e78a4c05aedc34d014d0c29d7d536caa3a04bc173aa0ade6a64a139b3b9f"


def prepare():
    STATE.mkdir(exist_ok=True, mode=0o700)
    upstream = STATE / "upstream.yml"
    if not upstream.exists():
        with urllib.request.urlopen(URL, timeout=30) as response:
            content = response.read()
        if hashlib.sha256(content).hexdigest() != UPSTREAM_SHA256:
            raise ValueError("Upstream compose checksum mismatch; refusing to run it")
        upstream.write_bytes(content)
    if hashlib.sha256(upstream.read_bytes()).hexdigest() != UPSTREAM_SHA256:
        raise ValueError("Cached compose checksum mismatch")
    config = yaml.safe_load(upstream.read_text())
    config["name"] = "civicloop-datahub"
    config["networks"]["default"].pop("name", None)
    for volume in config["volumes"].values():
        volume.pop("name", None)
    # Actions are unnecessary for explicit, manual ingestion.
    config["services"].pop("datahub-actions-quickstart")
    token_file = STATE / "local-secrets.yml"
    if not token_file.exists():
        fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            yaml.safe_dump(
                {
                    key: secrets.token_urlsafe(48)
                    for key in (
                        "DATAHUB_SYSTEM_CLIENT_SECRET",
                        "DATAHUB_TOKEN_SERVICE_SALT",
                        "DATAHUB_TOKEN_SERVICE_SIGNING_KEY",
                        "DATAHUB_SECRET",
                    )
                },
                output,
            )
    local_secrets = yaml.safe_load(token_file.read_text())
    for name, service in config["services"].items():
        service.pop("profiles", None)
        service.pop("ports", None)
        environment = service.get("environment", {})
        for key in environment:
            if key in local_secrets:
                environment[key] = local_secrets[key]
        for volume in service.get("volumes", []):
            if volume["type"] == "bind":
                # No host home-directory mounts or dependency on host permissions.
                volume_name = (
                    "plugins"
                    if volume["target"].endswith("plugins")
                    else "search-config"
                )
                volume.clear()
                volume.update(
                    type="volume",
                    source=volume_name,
                    target=f"/etc/datahub/{'plugins' if volume_name == 'plugins' else 'search'}",
                )
                config["volumes"][volume_name] = {}
    gms = config["services"]["datahub-gms-quickstart"]
    gms["ports"] = ["127.0.0.1:18080:8080"]
    gms["environment"]["METADATA_SERVICE_AUTH_ENABLED"] = "true"
    config["services"]["frontend-quickstart"]["ports"] = ["127.0.0.1:19002:9002"]
    compose = STATE / "compose.yml"
    compose.write_text(yaml.safe_dump(config, sort_keys=False))
    compose.chmod(0o600)
    return compose


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["up", "down", "status"])
    args = parser.parse_args()
    compose = prepare() if args.action == "up" else STATE / "compose.yml"
    if not compose.exists():
        parser.error("No local DataHub setup exists; run up first")
    env = {
        **os.environ,
        "DATAHUB_VERSION": VERSION,
        "UI_INGESTION_DEFAULT_CLI_VERSION": "1.7.0.14",
    }
    command = ["docker", "compose", "-f", str(compose), "-p", "civicloop-datahub"]
    action = {
        "up": ["up", "-d", "--wait", "--wait-timeout", "300"],
        "down": ["down"],
        "status": ["ps"],
    }[args.action]
    subprocess.run(command + action, env=env, check=True)
    if args.action == "up":
        print(
            "DataHub UI: http://localhost:19002 (local quickstart login: datahub / datahub)"
        )
        print(
            "GMS: http://localhost:18080; create a local ingestion access token in the UI."
        )


if __name__ == "__main__":
    main()
