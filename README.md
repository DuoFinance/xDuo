# Uni2 Legacy NeoX

A conservative Uniswap V2 fork for NeoX deployment.

## Design goals

- Keep `core` behavior aligned with the canonical Uniswap V2 legacy implementation.
- Keep `periphery` on the canonical router compiler line.
- Avoid protocol-level anti-MEV modifications inside AMM contracts.
- Support NeoX and optional anti-MEV/private orderflow at the RPC and transaction configuration layer.
- Reuse the existing `EvmTokenDeployer`, `DuoSwapToken`, and single-pool `DuoSwapStaking` contracts from the source workspace.

## Compiler policy

- `UniswapV2Factory`, `UniswapV2Pair`, `UniswapV2ERC20`: `0.5.16`
- `UniswapV2Router01`, `UniswapV2Router02`: `0.6.6`
- `DuoSwapToken`, `DuoSwapStaking`, `EvmTokenDeployer`: `0.8.26`

This preserves the legacy Uniswap V2 compiler targets while allowing the auxiliary contracts to stay on the more modern OpenZeppelin-based implementation already present in the source repo.

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

Minimum router deployment config:

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
npm run build
npm test
npm run deploy:testnet
npm run deploy:mainnet
npm run deploy:token:testnet
npm run deploy:deployer:testnet
npm run deploy:staking:testnet
npm run manage:staking:testnet
```

Staking management actions are driven by env vars. Set `DUO_STAKING_ACTION` to one of:
`createPool`, `createPoolWithRewards`, `startRewards`, `fundAndStartRewards`, `addRewards`, `recoverEndedRewards`.

Common staking management env vars:

```bash
DUO_STAKING_FACTORY_ADDRESS=
DUO_STAKING_ADDRESS=
DUO_STAKING_LP_TOKEN=
DUO_STAKING_REWARD_TOKEN=
DUO_STAKING_OWNER=
DUO_STAKING_REWARD_AMOUNT=
DUO_STAKING_REWARD_BLOCKS=
DUO_STAKING_RECOVERY_TO=
DUO_STAKING_RECOVERY_AMOUNT=
```

## Notes

- The router expects the official NeoX wrapped gas token address in `*_WGAS_ADDRESS`.
- The fork only localizes imports; it does not intentionally alter the AMM math or fee logic.
- `DuoSwapStaking` reads LP token addresses from `DUO_STAKING_POOLS`, using the `LP` part of `LP:ALLOC` entries.
- Scripts prefer `DUO_*` env vars. `OS_*` aliases are still accepted for backward compatibility.
