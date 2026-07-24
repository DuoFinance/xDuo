#!/usr/bin/env bash
# Start Anvil node in background for liveTest
set -euo pipefail

if curl -s http://127.0.0.1:8545 > /dev/null 2>&1; then
  echo "Anvil is already running on http://127.0.0.1:8545"
  exit 0
fi

echo "Starting Anvil..."
anvil --silent &
ANVIL_PID=$!
sleep 2

if curl -s http://127.0.0.1:8545 > /dev/null 2>&1; then
  echo "Anvil started (PID: $ANVIL_PID) on http://127.0.0.1:8545"
  echo "Run: pkill anvil   to stop"
else
  echo "Failed to start Anvil. Is foundry installed? Run: curl -L https://foundry.paradigm.xyz | bash"
  kill $ANVIL_PID 2>/dev/null || true
  exit 1
fi
