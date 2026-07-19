// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Constants
library Constants {
    /* ============ Token Parameters ============ */
    /// @dev Total supply fixed at 1 B, 18 decimals
    uint256 constant TOTAL_SUPPLY = 1_000_000_000 * 1e18;

    /* ============ Graduation Parameters ============ */
    /// @dev Graduation ratio P range: 60% ~ 99% (bps)
    /// P > 60% ensures VirtualGas/VirtualToken are positive
    uint256 constant MIN_GRADUATION_BPS = 6000;
    uint256 constant MAX_GRADUATION_BPS = 9900;
    uint256 constant BPS_DENOMINATOR   = 10000;

}
