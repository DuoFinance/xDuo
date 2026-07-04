// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title 
/// @notice CP-AMM (x*y=k)  amountOut 
/// @dev  pure，
library CurveMath {
    /* ============ ：amountIn(gas) -> amountOut(token) ============ */
    /// @dev amountOut = reserveOut * amountIn / (reserveIn + amountIn)
    function getAmountOut(
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 amountIn
    ) internal pure returns (uint256) {
        require(amountIn > 0, "ZERO_INPUT");
        require(reserveIn > 0 && reserveOut > 0, "INSUFFICIENT_LIQUIDITY");
        uint256 amountInWithFee = amountIn; // fee 
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn + amountInWithFee;
        return numerator / denominator;
    }

    /* ============ ：amountOut(token) -> amountIn(gas) ============ */
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
        return (numerator / denominator) + 1; // ，
    }
}
