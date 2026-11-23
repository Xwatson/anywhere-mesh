"""Run one Antigravity CLI ACP server on the accepted local socket as the logged-in desktop user."""
import os

args = ["/home/desktop/.local/bin/agy", "acp", "--disable-telemetry"]
os.execv(args[0], args)
