#!/usr/bin/env bash
# Start Anvil node (forking NeoX mainnet) in background for liveTest
set -euo pipefail

ANVIL_PORT="${ANVIL_PORT:-8545}"

if curl -s "http://127.0.0.1:${ANVIL_PORT}" > /dev/null 2>&1; then
  echo "Anvil is already running on http://127.0.0.1:${ANVIL_PORT}"
  exit 0
fi

echo "Starting Anvil (fork NeoX mainnet)..."
anvil \
  --fork-url https://mainnet-1.rpc.banelabs.org \
  --port "${ANVIL_PORT}" \
  --chain-id 1337 \
  --host 0.0.0.0 \
  --block-time 12 \
  --silent &
ANVIL_PID=$!
# fork startup needs more time
for i in $(seq 1 10); do
  if curl -s "http://127.0.0.1:${ANVIL_PORT}" > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

if curl -s "http://127.0.0.1:${ANVIL_PORT}" > /dev/null 2>&1; then
  echo "Anvil started (PID: $ANVIL_PID) on http://127.0.0.1:${ANVIL_PORT} (chain-id 1337, fork mainnet)"
  echo "Run: pkill anvil   to stop"
else
  echo "Failed to start Anvil. Is foundry installed? Run: curl -L https://foundry.paradigm.xyz | bash"
  kill $ANVIL_PID 2>/dev/null || true
  exit 1
fi
