"""Adds or removes Pixel Office's tools ("office" MCP server) in ONE Hermes profile, using Hermes' own config code.

Run by the office (src/server/hermes.ts) with Hermes' venv Python:
    python hermes-link.py <hermes-agent folder>        (HERMES_HOME = the profile's folder)
stdin:  {"action": "link"|"unlink", "name": "office", "url": "...", "token": "..."}
stdout: one JSON line {"ok": true} or {"ok": false, "error": "..."}

Before any change, config.yaml and .env are copied to <profile>/.pixel-office-backup/<file>.<time>.
The entry is written the way `hermes mcp add --auth header` writes one: the key in .env, a ${...} reference in config.yaml.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
import hermes_bootstrap  # noqa: E402,F401 -- must come first; may relaunch in Hermes' own Python

import json  # noqa: E402
import os  # noqa: E402
import shutil  # noqa: E402
import time  # noqa: E402


def answer(ok, error=None):
    print(json.dumps({"ok": ok, **({"error": str(error)[:400]} if error else {})}, ensure_ascii=False), flush=True)


def main():
    req = json.loads(sys.stdin.read() or "{}")
    action, name = req.get("action"), req.get("name") or "office"
    if action not in ("link", "unlink"):
        return answer(False, "unknown action")
    from hermes_cli.config import load_config, save_config, save_env_value

    home = Path(os.environ["HERMES_HOME"])
    backup = home / ".pixel-office-backup"
    backup.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    for f in ("config.yaml", ".env"):
        if (home / f).is_file():
            shutil.copy2(home / f, backup / f"{f}.{stamp}")

    key = "MCP_" + "".join(c if c.isalnum() else "_" for c in name.upper()).strip("_") + "_API_KEY"
    config = load_config()
    servers = config.get("mcp_servers") or {}
    if action == "link":
        url, token = req.get("url"), req.get("token")
        if not url or not token:
            return answer(False, "url and token are required")
        save_env_value(key, token)
        servers[name] = {"url": url, "headers": {"Authorization": "Bearer ${" + key + "}"}, "connect_timeout": 10}
    else:
        servers.pop(name, None)
    config["mcp_servers"] = servers
    save_config(config)
    answer(True)


try:
    main()
except Exception as exc:  # the office shows this line next to the profile
    answer(False, f"{type(exc).__name__}: {exc}")
