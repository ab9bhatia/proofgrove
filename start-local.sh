#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export PROOFGROVE_MODE=local
export PROOFGROVE_MODEL="${PROOFGROVE_MODEL:-llama3.2:latest}"
exec python3 "$PWD/scripts/run_local.py"
