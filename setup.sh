#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
command -v uv >/dev/null || { echo 'Install uv first: brew install uv'; exit 1; }
command -v pnpm >/dev/null || { echo 'Install Node.js and pnpm first: brew install node pnpm'; exit 1; }
(cd backend && uv sync --frozen --extra dev)
(cd ui && pnpm install --frozen-lockfile && NEXT_TELEMETRY_DISABLED=1 pnpm build)
echo 'Setup complete. Run ./start.sh and open http://localhost:3010/learn'
