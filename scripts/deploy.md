# Staking Deployment Guide

## Deploy the swap trio
`npm run deploy:legacy`,
return `factory`, `router`, `tokenDeployer`,

## Deploy Duo Reward Token
`npm run deploy:duo:legacy`,
Parameters: totalSupply, treasury address, owner address,
return DUO_TOKEN_ADDRESS or DUO_STAKING_REWARD_TOKEN

## Create trading pair lpToken
`create pair`
return `lpToken`

## Deploy Staking Contract
`npm run deploy:staking:legacy`
Parameters:
    duo reward token address, 
    lpToken addess, 
    Owner address.

    INIT_ALLOCATION: boolean,
    INIT_REWARDS: boolean,
    REWARD_AMOUNT: integer,
    REWARD_BLOCKS: integer,
    STAKING_ACTIONS: boolean,

return STAKING_ADDRESS

