# Staking Deployment Guide

For a local Anvil fork of NeoX mainnet:

```sh
npm run deploy:staking:anvil
npm run manage:staking:anvil
```

Set `STAKING_POOLS` to exactly one LP token address and `TOKEN_ADDRESS` to the
reward token address before deploying. The script saves the staking contract
address as `STAKING` and the LP token as `DUOGAS` in the network's address file.
For Anvil, configure values with the `ANVIL_` prefix or shared `DUO_` prefix.

The Anvil commands store and read addresses from `deployed.anvil.json`, keeping
local fork addresses separate from network deployments. NeoX testnet and mainnet
use `deployed.testnet.json` and `deployed.mainnet.json`, respectively.
`scripts/manageStaking.ts` checks that the connected wallet owns the staking
contract before sending management transactions.
