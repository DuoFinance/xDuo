#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

NETWORK="${1:-anvil}"
FAILED=()
PASSED=0

TESTS=(
  "scripts/liveTest/pumpLive.live.ts"
  "scripts/liveTest/pumpGradientLive.live.ts"
  "scripts/liveTest/pumpCallbackLive.live.ts"
  "scripts/liveTest/uniswapV2FactoryLive.live.ts"
  "scripts/liveTest/uniswapV2RouterLive.live.ts"
  "scripts/liveTest/item02_gradCrossReentrant.live.ts"
  "scripts/liveTest/item03_createAndBuy.live.ts"
  "scripts/liveTest/item05_mevSandwich.live.ts"
  "scripts/liveTest/item06_feeOnTransfer.live.ts"
  "scripts/liveTest/item07_blacklistToken.live.ts"
  "scripts/liveTest/item08_hookToken.live.ts"
  "scripts/liveTest/item09_noOwnership.live.ts"
  "scripts/liveTest/item10_extremeReserve.live.ts"
  "scripts/liveTest/item11_gasGriefing.live.ts"
)

echo "═══════════════════════════════════════════════════"
echo "  Running all live tests on --network $NETWORK"
echo "═══════════════════════════════════════════════════"
echo

for test in "${TESTS[@]}"; do
  NAME=$(basename "$test" .live.ts)
  echo ""
  echo "───────────────────────────────────────────────"
  echo "  ▶ $NAME"
  echo "───────────────────────────────────────────────"
  if npx hardhat run "$test" --network "$NETWORK" 2>&1; then
    echo ""
    echo "  ✅ $NAME PASSED"
    PASSED=$((PASSED + 1))
  else
    echo ""
    echo "  ❌ $NAME FAILED"
    FAILED+=("$NAME")
  fi
done

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Results: $PASSED/${#TESTS[@]} passed"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "  Failed: ${FAILED[*]}"
fi
echo "═══════════════════════════════════════════════════"

[ ${#FAILED[@]} -eq 0 ]
