# Experimental mock session host

This service runs in the lab **US network namespace**, independently of Electron. It owns conversation history and invokes the existing trusted `WorkspaceExecutor`/MCP adapter. Desktop HTTP/WSS clients and domestic Agent WSS clients have different pinned mTLS identities and routes. No production server routes or real CLI are changed.

The desktop/session architecture, deployment, recovery rules, limitations and reproduction steps are in [the D2 README](../desktop-sessions/README.md). `main.mjs` serves HTTPS on the EasyTier address; `runtime.mjs` drives durable turns; `store.mjs` persists receipts/events in SQLite; `mock.mjs` translates explicit lab commands into real MCP calls.

The mock accepts `/read path`, `/list [path]`, `/search pattern`, `/append path text`, `/build`, `/long` and `/run command`. Natural language returns usage help rather than executing inferred commands. Edits require a same-session file read revision; execution requires local execute permission. This deterministic adapter validates transport and tools, not AI coding quality or real CLI compatibility.

The D2 entry point uses fixed laboratory identities. [D3](../account-devices/README.md) reuses this runtime per authenticated account and stores the execution device in each session. Production account/project integration and F's real CLI validation are pending.
