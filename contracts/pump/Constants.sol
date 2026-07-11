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

}
