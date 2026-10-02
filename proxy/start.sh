#!/usr/bin/env bash
cd "$(dirname "$0")/.." || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js belum terpasang (https://nodejs.org)."; exit 1; }
if [ ! -f dist-offline/index.html ]; then
  echo "Build offline belum ada, membuatnya dulu..."
  node proxy/build-offline.mjs || exit 1
fi
exec node proxy/server.mjs
