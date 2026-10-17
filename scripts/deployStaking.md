# Staking Deployment Guide

For a local Anvil fork of NeoX mainnet:

```sh
npm run deploy:staking:anvil
npm run manage:staking:anvil
```

Before deploying staking, deploy DUO and its DUO-GAS pair. The staking script
loads `DUO` and `DUOGAS` from the selected network's address file and verifies
that both addresses have contract code on the connected chain. Configure only
deployment parameters such as staking owner, reward blocks, and reward-start
options in `.env`.

The Anvil commands store and read addresses from `deployed.anvil.json`, keeping
local fork addresses separate from network deployments. NeoX testnet and mainnet
use `deployed.testnet.json` and `deployed.mainnet.json`, respectively.
`scripts/manageStaking.ts` checks that the connected wallet owns the staking
contract before sending transactions and only adds rewards to an already-started
pool. It reads the reward amount and duration from `.env`.
