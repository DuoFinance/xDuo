# Staking 

## swap
`npm run deploy:legacy`,
return `factory`, `router`, `tokenDeployer`,

##  Duo 
`npm run deploy:duo:legacy`,
： totalSupply, treasury address, owner address,
return DUO_TOKEN_ADDRESS or DUO_STAKING_REWARD_TOKEN

##  lpToken
`create pair`
return `lpToken`

##  Staking 
`npm run deploy:staking:legacy`
：
    duo reward token address, 
    lpToken addess, 
    Owner address.

    INIT_ALLOCATION: boolean,
    INIT_REWARDS: boolean,
    REWARD_AMOUNT: integer,
    REWARD_BLOCKS: integer,
    STAKING_ACTIONS: boolean,

return STAKING_ADDRESS

