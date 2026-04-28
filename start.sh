#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

uv sync

(cd web && npm install && npm run build)
rm -rf web_dist
cp -R web/out web_dist

uv run python main.py
