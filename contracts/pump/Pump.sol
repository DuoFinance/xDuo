// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Pump - pump.fun style Fair Launch contract
/// @notice Uses CP-AMM (x*y=k) virtual pool, auto-creates Uniswap V2 pool on graduation
/// @dev Mirrors pump.fun core logic:
///   - Internal bonding curve two-way trading
///   - Graduates when raised gas reaches TARGET_RAISE
///   - All remaining tokens + gas go into Uniswap V2 on graduation
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./IPump.sol";
import "./Constants.sol";
import "./CurveMath.sol";
import "./PumpToken.sol";
import "./IUniswapV2.sol";

contract Pump is IPump, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    /* ============ Data Structures ============ */
    struct SaleInfo {
        address creator;
        uint256 totalSupply;     // Fixed 1B
        uint256 tokensSold;      // Tokens sold
        uint256 gasRaised;       // Gas raised
        uint256 targetRaise;     // Graduation target gas
        uint256 virtualGas;      // vGas
        uint256 virtualToken;    // vToken
        uint256 graduationBps;   // P（bps）
        bool    graduated;       // Whether graduated
        address pair;            // Uniswap pair after graduation
    }

    /* ============ State ============ */
    mapping(address => SaleInfo) private sales;
    IUniswapV2Router public immutable uniswapRouter;

    /* ============ Modifiers ============ */
    modifier saleActive(address token) {
        SaleInfo storage s = sales[token];
        require(s.creator != address(0), "SALE_NOT_EXIST");
        require(!s.graduated, "SALE_GRADUATED");
        _;
    }

    /* ============ Constructor ============ */
    /// @param uniswapRouter_ Uniswap V2 Router address
    constructor(address uniswapRouter_) Ownable(msg.sender) {
        uniswapRouter = IUniswapV2Router(uniswapRouter_);
    }

    /* ============ Create Sale ============ */
    /// @inheritdoc IPump
    function createSale(
        string calldata name,
        string calldata symbol,
        uint256 graduationBps
    ) external returns (address token) {
        require(graduationBps >= Constants.MIN_GRADUATION_BPS, "INVALID_GRADUATION_MIN");
        require(graduationBps <= Constants.MAX_GRADUATION_BPS, "INVALID_GRADUATION_MAX");

        // Deploy token, all supply goes to this contract
        token = address(new PumpToken(
            name,
            symbol,
            Constants.DECIMALS,
            Constants.TOTAL_SUPPLY,
            address(this)
        ));

        // Calculate virtual pool parameters (P = p / BPS_DENOM)
        // vToken = T * p² / BPS_DENOM / (2p - BPS_DENOM)
        // vGas   = R * (BPS_DENOM - p) / (2p - BPS_DENOM)
        uint256 p = graduationBps;
        uint256 twoPminusOne = 2 * p - Constants.BPS_DENOMINATOR;
        require(twoPminusOne > 0, "INVALID_GRADUATION");

        uint256 pSquared = p * p;
        uint256 vToken = Constants.TOTAL_SUPPLY * pSquared / Constants.BPS_DENOMINATOR / twoPminusOne;
        uint256 vGas   = Constants.TARGET_RAISE * (Constants.BPS_DENOMINATOR - p) / twoPminusOne;

        sales[token] = SaleInfo({
            creator: msg.sender,
            totalSupply: Constants.TOTAL_SUPPLY,
            tokensSold: 0,
            gasRaised: 0,
            targetRaise: Constants.TARGET_RAISE,
            virtualGas: vGas,
            virtualToken: vToken,
            graduationBps: p,
            graduated: false,
            pair: address(0)
        });

        emit SaleCreated(msg.sender, token, name, symbol);
        return token;
    }

    /* ============ Buy ============ */
    /// @inheritdoc IPump
    function buy(address token, uint256 minTokensOut)
        external
        payable
        saleActive(token)
        nonReentrant
        returns (uint256 tokensOut)
    {
        SaleInfo storage s = sales[token];
        require(msg.value > 0, "ZERO_GAS");

        // 1. Calculate current virtual reserves
        uint256 gasReserve   = s.virtualGas + s.gasRaised;
        uint256 tokenReserve = s.virtualToken - s.tokensSold;
        require(tokenReserve > 0, "NO_TOKENS_LEFT");

        // 2. Calculate tokens due
        uint256 gasIn = msg.value;
        tokensOut = CurveMath.getAmountOut(gasReserve, tokenReserve, gasIn);
        require(tokensOut > 0, "ZERO_TOKENS");
        require(tokensOut >= minTokensOut, "SLIPPAGE");

        // 3. Prevent buying all before graduation, cap at graduation point (P * T)
        uint256 maxTokens = s.totalSupply * s.graduationBps / Constants.BPS_DENOMINATOR;
        uint256 remainingToGrad = maxTokens - s.tokensSold;
        if (tokensOut > remainingToGrad) {
            tokensOut = remainingToGrad;
            // Back-calculate actual gas needed
            gasIn = CurveMath.getAmountIn(gasReserve, tokenReserve, tokensOut);
            // Refund overpaid gas
            uint256 refund = msg.value - gasIn;
            if (refund > 0) {
                (bool ok, ) = msg.sender.call{value: refund}("");
                require(ok, "REFUND_FAILED");
            }
        }

        // 4. Update state
        s.tokensSold += tokensOut;
        s.gasRaised  += gasIn;

        // 5. Transfer tokens to buyer
        IERC20(token).safeTransfer(msg.sender, tokensOut);

        emit TokensPurchased(msg.sender, token, gasIn, tokensOut);

        // 6. Check if graduated
        if (s.gasRaised >= s.targetRaise) {
            _graduate(token);
        }
    }

    /* ============ Sell ============ */
    /// @inheritdoc IPump
    function sell(address token, uint256 tokensIn, uint256 minGasOut)
        external
        saleActive(token)
        nonReentrant
        returns (uint256 gasOut)
    {
        SaleInfo storage s = sales[token];
        require(tokensIn > 0, "ZERO_TOKENS");

        // 1. Transfer tokens from seller
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);

        // 2. Calculate current virtual reserves
        uint256 gasReserve   = s.virtualGas + s.gasRaised;
        uint256 tokenReserve = s.virtualToken - s.tokensSold;

        // 3. Calculate gas due
        gasOut = CurveMath.getAmountOut(tokenReserve, gasReserve, tokensIn);
        require(gasOut > 0, "ZERO_GAS");
        require(gasOut >= minGasOut, "SLIPPAGE");
        require(gasOut <= s.gasRaised, "INSUFFICIENT_GAS");

        // 4. Update state
        s.tokensSold -= tokensIn;
        s.gasRaised  -= gasOut;

        // 5. Transfer gas to seller
        (bool ok, ) = msg.sender.call{value: gasOut}("");
        require(ok, "GAS_TRANSFER_FAILED");

        emit TokensSold(msg.sender, token, tokensIn, gasOut);
    }

    /* ============ Graduation ============ */
    /// @dev On graduation:
    ///   - All remaining tokens go into the Uniswap V2 pool
    ///   - All raised gas goes into the pool
    ///   - LP token sent to burn address (address(0)), ownership renounced
    ///   - No burn, virtual pool amplification ensures smooth price transition
    function _graduate(address token) internal {
        SaleInfo storage s = sales[token];
        s.graduated = true;

        uint256 tokensForLP = s.totalSupply - s.tokensSold;
        require(tokensForLP > 0, "NO_TOKENS_FOR_LP");
        uint256 gasForLP = s.gasRaised;
        require(gasForLP > 0, "NO_GAS_FOR_LP");

        // Approve Router to handle token
        IERC20(token).approve(address(uniswapRouter), tokensForLP);

        // Add liquidity via addLiquidityETH
        uint256 deadline = block.timestamp + 3600;
        (uint256 amountTokenUsed, uint256 amountGasUsed, ) =
            uniswapRouter.addLiquidityETH{value: gasForLP}(
                token,
                tokensForLP,
                tokensForLP,    // amountTokenMin
                gasForLP,       // amountGasMin
                address(0),     // LP token sent to burn address
                deadline
            );

        address pair = IUniswapV2Factory(IUniswapV2Router(uniswapRouter).factory()).getPair(token, uniswapRouter.WETH());
        s.pair = pair;

        emit SaleGraduated(token, pair, amountTokenUsed, amountGasUsed);
    }

    /* ============ Queries ============ */
    /// @inheritdoc IPump
    function getSale(address token) external view returns (
        address creator,
        uint256 totalSupply,
        uint256 tokensSold,
        uint256 gasRaised,
        uint256 targetRaise,
        uint256 virtualGas,
        uint256 virtualToken,
        uint256 graduationBps,
        bool    graduated
    ) {
        SaleInfo storage s = sales[token];
        return (s.creator, s.totalSupply, s.tokensSold, s.gasRaised,
                s.targetRaise, s.virtualGas, s.virtualToken, s.graduationBps, s.graduated);
    }

    /// @inheritdoc IPump
    function getCurrentPrice(address token) external view returns (uint256) {
        SaleInfo storage s = sales[token];
        require(s.creator != address(0), "SALE_NOT_EXIST");
        require(!s.graduated, "SALE_GRADUATED");
        uint256 gasReserve   = s.virtualGas + s.gasRaised;
        uint256 tokenReserve = s.virtualToken - s.tokensSold;
        require(tokenReserve > 0, "NO_TOKENS");
        // Price = gasReserve / tokenReserve * 1e18
        return gasReserve * 1e18 / tokenReserve;
    }

    /// @inheritdoc IPump
    function getTokensForGas(address token, uint256 gasAmount) external view returns (uint256) {
        SaleInfo storage s = sales[token];
        require(s.creator != address(0), "SALE_NOT_EXIST");
        require(!s.graduated, "SALE_GRADUATED");
        uint256 gasReserve   = s.virtualGas + s.gasRaised;
        uint256 tokenReserve = s.virtualToken - s.tokensSold;
        return CurveMath.getAmountOut(gasReserve, tokenReserve, gasAmount);
    }

    /// @inheritdoc IPump
    function getGasForTokens(address token, uint256 tokenAmount) external view returns (uint256) {
        SaleInfo storage s = sales[token];
        require(s.creator != address(0), "SALE_NOT_EXIST");
        require(!s.graduated, "SALE_GRADUATED");
        uint256 gasReserve   = s.virtualGas + s.gasRaised;
        uint256 tokenReserve = s.virtualToken - s.tokensSold;
        return CurveMath.getAmountOut(tokenReserve, gasReserve, tokenAmount);
    }

    /* ============ Receive gas ============ */
    receive() external payable {}
}
