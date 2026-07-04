// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  - pump.fun 
library Constants {
    /* ============  ============ */
    /// @dev  1 B（ pump.fun ）
    uint256 constant TOTAL_SUPPLY = 1_000_000_000 * 1e18;

    /// @dev decimals  18
    uint8   constant DECIMALS = 18;

    /* ============  ============ */
    /// @dev  P ：50% ~ 80%（bps）
    /// P > 50%  VirtualGas/VirtualToken 
    uint256 constant MIN_GRADUATION_BPS = 5000;
    uint256 constant MAX_GRADUATION_BPS = 8000;
    uint256 constant BPS_DENOMINATOR   = 10000;

    /* ============  gas  ============ */
    /// @dev pump.fun  85 SOL ， 30 ETH 
    uint256 constant TARGET_RAISE = 30 ether;
}
