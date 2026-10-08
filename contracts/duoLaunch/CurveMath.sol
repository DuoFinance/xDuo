// SPDX-License-Identifier: MIT
// Note: generic x*y=k in CurveMath alone is not protected; only its combination with the virtual-reserve model is.
pragma solidity ^0.8.24;

/// @title Curve math library
/// @notice CP-AMM (x*y=k) standard amountOut formula
/// @dev All functions are pure, no chain state reads/writes
library CurveMath {
    /* ============ Buy: amountIn(GAS) -> amountOut(token) ============ */
    /// @dev amountOut = reserveOut * amountIn / (reserveIn + amountIn)
    function getAmountOut(
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 amountIn
    ) internal pure returns (uint256) {
        require(amountIn > 0, "ZERO_INPUT");
        require(reserveIn > 0 && reserveOut > 0, "INSUFFICIENT_LIQUIDITY");
        uint256 numerator = amountIn * reserveOut;
        uint256 denominator = reserveIn + amountIn;
        return numerator / denominator;
    }

    /* ============ Reverse Buy: amountOut(token) -> amountIn(GAS) ============ */
    /// @dev amountIn = reserveIn * amountOut / (reserveOut - amountOut)
    function getAmountIn(
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 amountOut
    ) internal pure returns (uint256) {
        require(amountOut > 0, "ZERO_OUTPUT");
        require(reserveIn > 0 && reserveOut > amountOut, "INSUFFICIENT_LIQUIDITY");
        uint256 numerator = reserveIn * amountOut;
        uint256 denominator = reserveOut - amountOut;
        return (numerator / denominator) + 1; // round up to protect the curve
    }
}
