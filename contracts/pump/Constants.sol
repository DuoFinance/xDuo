// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Constants - pump.fun style parameters
library Constants {
    /* ============ Token Parameters ============ */
    /// @dev Total supply fixed at 1 B (same as pump.fun)
    uint256 constant TOTAL_SUPPLY = 1_000_000_000 * 1e18;

    /// @dev decimals fixed to 18
    uint8   constant DECIMALS = 18;

    /* ============ Graduation Parameters ============ */
    /// @dev Graduation ratio P range: 50% ~ 80% (bps)
    /// P > 50% ensures VirtualGas/VirtualToken are positive
    uint256 constant MIN_GRADUATION_BPS = 5000;
    uint256 constant MAX_GRADUATION_BPS = 9900;
    uint256 constant BPS_DENOMINATOR   = 10000;

    /* ============ Uniswap V2 CREATE2 Parameters ============ */
    /// @dev Uniswap V2 pair initialization code hash (matches local UniswapV2Library)
    bytes32 constant INIT_CODE_PAIR_HASH = 0xbbbb25d7dbd3ac53985ee4587c020269570d6f99ec2613ae13fe973a2ffbf2f5;
}
