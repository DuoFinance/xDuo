# Staking Deployment Guide

`npx hardhat run scripts/deployStaking.ts --network legacy`

Set `STAKING_POOLS` to exactly one LP token address and `TOKEN_ADDRESS` to the
reward token address before deploying. The script saves the staking contract
address as `STAKING` and the LP token as `DUOGAS` in `deployed.json`.

`scripts/manageStaking.ts` reads both addresses from `deployed.json` and checks
that the connected wallet owns the staking contract before sending management
transactions.
