// SPDX-License-Identifier: MIT
// Additional Restriction: Duo 3Y Algorithm Non-Copy (virtual GAS / virtual Token) — see LICENSE Section B. Expires 2029-08-31.
pragma solidity ^0.8.24;

/// @title Constants
library Constants {
    /* ============ Token Parameters ============ */
    /// @dev Total supply fixed at 1 B, 18 decimals
    uint256 constant TOTAL_SUPPLY = 1_000_000_000 * 1e18;

    /* ============ Graduation Parameters ============ */
    /// @dev Graduation ratio P range: 60% ~ 99.99% (bps)
    /// P >= 60% ensures VirtualGas/VirtualToken are positive
    uint256 constant MIN_GRADUATION_BPS = 6000;
    uint256 constant MAX_GRADUATION_BPS = 9999;
    uint256 constant BPS_DENOMINATOR   = 10000;

    /* ============ Fee Parameters ============ */
    /// @dev Protocol fee: 3 / 10000 = 0.03% on buy/sell
    uint256 constant FEE_FACTOR      = 3;
    uint256 constant FEE_DENOMINATOR = 10000;

}
