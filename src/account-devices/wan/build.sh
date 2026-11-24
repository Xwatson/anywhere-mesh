#!/usr/bin/env bash
# Run in the existing build guest. The archive contains only the server, stdio MCP and web assets.
set -eu
src=$(cd "$(dirname "$0")/../../.." && pwd)
dest=${1:?staging directory required}
mkdir -p "$dest/ui"
cd "$src"
node_modules/.bin/esbuild src/account-devices/wan/{server,mcp}.mjs \
  --bundle --platform=node --target=node24 --format=esm --out-extension:.js=.mjs --outdir="$dest" \
  --banner:js="import {createRequire as __nodeRequire} from 'node:module';const require=__nodeRequire(import.meta.url);" \
  --external:bufferutil --external:utf-8-validate --legal-comments=eof
cp src/account-devices/wan/agy-mcp-bridge.mjs "$dest/agy-mcp-bridge.mjs"
cp src/account-devices/ui/{index.html,app.js,thread.js,style.css,manifest.webmanifest,sw.js,icon-192.png,icon-512.png} "$dest/ui/"
