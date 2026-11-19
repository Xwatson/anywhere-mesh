"""Run one app-server on the accepted local socket as the existing Codex login."""
import json
import os
from pathlib import Path
import tomllib

args = ["/usr/bin/codex", "app-server", "--listen", "stdio://"]
for feature in ("shell_tool", "apps", "plugins", "multi_agent", "multi_agent_v2", "code_mode", "skill_search"):
    args.extend(["--disable", feature])
args.extend(["-c", 'web_search="disabled"', "-c", "mcp_servers={}", "-c", 'approval_policy="never"'])
config = Path.home() / ".codex" / "config.toml"
if config.is_file():
    for name in tomllib.loads(config.read_text()).get("mcp_servers", {}):
        args.extend(["-c", "mcp_servers." + json.dumps(name) + ".enabled=false"])
os.execv(args[0], args)
