# Third-party notices

The components listed here are excluded from the grants and restrictions in
the repository `LICENSE`. Their upstream license terms apply.

## OpenZeppelin Contracts

Source: <https://github.com/OpenZeppelin/openzeppelin-contracts>
Version used by this repository: 5.6.1
License: MIT (see the upstream `LICENSE` file)

The DuoLaunch and TokenTemplate contracts import OpenZeppelin Contracts.
OpenZeppelin source and copyright notices are not relicensed by this repository.

## forge-std

Source: <https://github.com/foundry-rs/forge-std>
Use: test-only git submodule
License: MIT OR Apache-2.0 (see the submodule license files)

## Uniswap V2 core

Source: <https://github.com/Uniswap/v2-core>
License: GPL-3.0-or-later (see `licenses/GPL-3.0.txt`)

Files:

- `contracts/UniswapV2Pair.sol`
- `contracts/UniswapV2ERC20.sol`
- `contracts/UniswapV2Factory.sol`
- `contracts/interfaces/IERC20.sol`
- `contracts/interfaces/IUniswapV2Callee.sol`
- `contracts/interfaces/IUniswapV2ERC20.sol`
- `contracts/interfaces/IUniswapV2Factory.sol`
- `contracts/interfaces/IUniswapV2Pair.sol`
- `contracts/libraries/Math.sol`
- `contracts/libraries/SafeMathCore.sol` (local rename of upstream `SafeMath.sol`)
- `contracts/libraries/UQ112x112.sol`

## Uniswap V2 periphery

Source: <https://github.com/Uniswap/v2-periphery>
License: GPL-3.0-or-later (see `licenses/GPL-3.0.txt`)

Files:

- `contracts/UniswapV2Router01.sol`
- `contracts/UniswapV2Router02.sol`
- `contracts/interfaces/IUniswapV2Router01.sol`
- `contracts/interfaces/IUniswapV2Router02.sol`
- `contracts/interfaces/IWETH.sol`
- `contracts/libraries/SafeMath.sol`
- `contracts/libraries/UniswapV2Library.sol`

## Uniswap Solidity library

Source: <https://github.com/Uniswap/solidity-lib>
License: GPL-3.0-or-later (see `licenses/GPL-3.0.txt`)

File:

- `contracts/libraries/TransferHelper.sol`

## WETH9

Source: <https://github.com/gnosis/canonical-weth>
License: GPL-3.0-or-later (see `licenses/GPL-3.0.txt`)

File:

- `contracts/Weth9.sol`

The SPDX identifiers above record the applicable upstream license for these
files. Local changes remain subject to the applicable GPL terms. The local
LP-token branding and pair initialization-code-hash changes are in
`contracts/UniswapV2ERC20.sol` and `contracts/libraries/UniswapV2Library.sol`;
the local WETH9 changes are noted in `contracts/Weth9.sol`.
