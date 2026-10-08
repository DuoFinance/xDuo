# xDuo — Uni2 + DuoLaunch on NeoX

A conservative Uniswap V2 fork for NeoX deployment, plus **DuoLaunch**: a fair-launch
bonding-curve contract (`x*y=k` virtual pool) that auto-creates a Uniswap V2 pool on graduation.

## Repo layout

- `contracts/UniswapV2*.sol`, `contracts/Weth9.sol` — frozen Uniswap V2 core/periphery (vendor code, do not modify)
- `contracts/duoLaunch/` — DuoLaunch fair-launch (`DuoLaunch.sol`, `CurveMath.sol`, `Constants.sol`, `IDuo.sol`, `TokenTemplate.sol`, `IUniswapV2.sol`)
- `contracts/duo/` — `DuoToken`, `MockUSDT` (test token: 1M supply, 4 decimals)
- `contracts/interfaces/`, `contracts/libraries/` — shared Uniswap V2 interfaces/math
- `contracts/test/` — test helpers (reentrancy/griefing mocks)
- `test/` — Hardhat tests, `testsol/` — Forge tests, `scripts/liveTest/` — Anvil live tests

## Design goals

- Keep `core` behavior aligned with the canonical Uniswap V2 legacy implementation.
- Keep `periphery` on the canonical router compiler line.
- Avoid protocol-level anti-MEV modifications inside AMM contracts.
- Support NeoX and optional anti-MEV/private orderflow at the RPC and transaction configuration layer.

## DuoLaunch

Fair launch on a virtual CP-AMM pool. Each sale deploys a fixed-supply (1B) `TokenTemplate`
held by DuoLaunch; users buy/sell against virtual reserves until the sale graduates into Uniswap V2.

### Creating a sale

```solidity
createSale(name, symbol, graduationBps, targetRaise, discord, x, telegram, repoUrl)
createAndBuy(name, symbol, graduationBps, targetRaise, minTokensOut, discord, x, telegram, repoUrl) payable
```

- `graduationBps` (P): **6000–9999** (60%–99.99% of supply sold at graduation). Outside this range reverts
  (`INVALID_GRADUATION_MIN/MAX`).
- `targetRaise`: expected GAS proceeds; must be `> 0` (`INVALID_TARGET_RAISE`). It shapes the curve,
  but graduation itself is triggered by **tokens sold**, not by GAS raised.
- `createAndBuy` creates the sale and buys in one tx (same-block snipe protection), with `minTokensOut`
  slippage guard. Metadata strings are capped (discord/x/telegram ≤ 128 chars, repoUrl ≤ 256).

### Virtual reserves

With `T = 1B`, `R = targetRaise`, `p = graduationBps`, `D = 10000`:

- `vToken = T·p² / (D·(2p−D))`
- `vGAS = R·(D−p) / (2p−D)`
- Effective reserves: `GASReserve = vGAS + GASRaised`, `tokenReserve = vToken − tokensSold`

Price: `GASReserve / tokenReserve` (`getCurrentPrice`, scaled by 1e18).

### Trading

- `buy(token, minTokensOut) payable` — 0.03% protocol fee on GAS in goes to the Uniswap factory's `feeTo`
  (no fee when `feeTo == address(0)`). Buys are capped at `maxTokens = T·p/D`; overpayment is refunded
  (refund failure is non-blocking) and hitting the cap triggers graduation.
- `sell(token, tokensIn, minGASOut)` — same 0.03% fee taken from GAS out; `GASOut ≤ GASRaised`
  (`INSUFFICIENT_GAS`); direct GAS transfers revert (`USE_BUY_FUNCTION`, use `buy`).
- Quotes: `getTokensForGAS` / `getGASForTokens` mirror on-chain math including the graduation cap and fee.

### Graduation

When `tokensSold >= maxTokens`, all remaining tokens + raised GAS are seeded into Uniswap V2
(bypassing the router to avoid front-run DoS); LP tokens are minted to `address(0)` (permanently locked).
Graduation preserves price continuity (bonding-curve close ≈ Uniswap open). Post-graduation
`buy`/`sell`/price quotes revert with `SALE_GRADUATED`.

## Compiler policy

- `UniswapV2Factory`, `UniswapV2Pair`, `UniswapV2ERC20`, `Weth9`: `0.5.16`
- `UniswapV2Router01`, `UniswapV2Router02`: `0.6.6`
- `duo/` (`DuoToken`, `MockUSDT`): `0.8.26`
- `duoLaunch/` (`DuoLaunch`, `IDuo`, `TokenTemplate`, `CurveMath`, `Constants`): `0.8.24` source, built with `0.8.26` + `viaIR`

This preserves the legacy Uniswap V2 compiler targets while keeping the newer contracts on the
OpenZeppelin-based implementation. Note: Hardhat and Foundry use separate caches
(`cache/` vs `cache-forge/`, see `foundry.toml` `cache_path`) — do not merge them.

## Anti-MEV support

There are no anti-MEV mutations in `core` or `periphery`.

If NeoX provides a private or protected transaction entrypoint, set `*_ANTI_MEV_RPC_URL` in `.env`. The deployment scripts will prefer that RPC URL over the public one. Gas mode can also be pinned per network:

- `*_TX_TYPE=legacy`
- `*_TX_TYPE=eip1559`
- `*_TX_TYPE=auto`

Optional fee overrides:

- `*_GAS_PRICE_GWEI`
- `*_MAX_FEE_PER_GAS_GWEI`
- `*_MAX_PRIORITY_FEE_PER_GAS_GWEI`

## Environment

Copy `.env.example` to `.env` and fill the network you use.

Minimum router + DuoLaunch deployment config:

```bash
NEOX_MAINNET_RPC_URL=
NEOX_MAINNET_CHAIN_ID=
NEOX_MAINNET_DEPLOYER_PRIVATE_KEY=
NEOX_MAINNET_WGAS_ADDRESS=
```

Optional protected orderflow config:

```bash
NEOX_MAINNET_ANTI_MEV_RPC_URL=
NEOX_MAINNET_TX_TYPE=auto
```

## Commands

```bash
npm install
npm run build            # hardhat compile
npm run test:hardhat     # 167 unit/integration tests
npm run test:forge       # forge tests (testsol/)
npm run test             # both
npm run test:live        # anvil live tests (scripts/liveTest/runAll.sh)
npm run deploy:testnet   # Factory + Router + DuoLaunch → neoxTestnet
npm run deploy:mainnet   # Factory + Router + DuoLaunch → neoxMainnet
npm run deploy:usdt:testnet  # MockUSDT (test token) → neoxTestnet
npm run deploy:usdt:mainnet  # MockUSDT (test token) → neoxMainnet
```

`scripts/deploy.ts` writes deployed addresses to `deployed.json` (and the UI config path).

## Notes

- The router expects the official NeoX wrapped gas token address in `*_WGAS_ADDRESS`.
- The fork only localizes imports; it does not intentionally alter the AMM math or fee logic.
- `MockUSDT` (`contracts/duo/MockUSDT.sol`) is a test-only token (1M supply, 4 decimals) — do not use on mainnet as a real stablecoin.


## License

See [`LICENSE`](./LICENSE) for the licensing terms. During the restriction period, only the virtual-reserve bonding-curve algorithm is subject to temporary commercial-use restrictions; other code for which the copyright holder can grant rights is MIT-licensed. Third-party components retain their own licenses.

- **Effective:** 2026-10-31 through 2029-10-30. Starting 2029-10-31, the algorithm is automatically licensed under MIT.
- **Restricted scope:** the combination of virtual reserves, reserve-based buy/sell pricing, and graduation parameterization described in Section B. It is asset- and chain-agnostic. Generic `x*y=k` math, the DuoLaunch contract as a whole, interfaces, and other code are not restricted as such.
- **During the restriction period:** non-commercial use and derivative works are allowed. Commercial deployment/operation and providing a derivative implementation for a commercial purpose require prior written permission.
