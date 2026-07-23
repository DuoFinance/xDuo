// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DuoLaunch - Fair Launch contract on NeoX
/// @notice Uses CP-AMM (x*y=k) virtual pool, auto-creates Uniswap V2 pool on graduation
/// @dev Github repo : https://github.com/DuoFinance/xDuo.git
///   - Internal bonding curve two-way trading
///   - Graduates when the configured token-sale allocation is sold
///   - All remaining tokens + GAS go into Uniswap V2 on graduation
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./IDuo.sol";
import "./Constants.sol";
import "./CurveMath.sol";
import "./TokenTemplate.sol";
import "./IUniswapV2.sol";


contract DuoLaunch is IDuo, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ============ Data Structures ============ */
    struct SaleInfo {
        address creator;
        uint256 tokensSold;      // Tokens sold
        uint256 GASRaised;       // GAS raised
        uint256 targetRaise;     // Graduation target GAS raised
        uint256 virtualGAS;      // vGAS
        uint256 virtualToken;    // vToken
        uint256 graduationBps;   // P（bps）
        bool    graduated;       // Whether graduated
    }

    /* ============ State ============ */
    mapping(address => SaleInfo) private sales;
    address public immutable uniswapFactory;
    address public immutable weth;

    /* ============ Modifiers ============ */
    modifier saleActive(address token) {
        SaleInfo storage s = sales[token];
        require(s.creator != address(0), "SALE_NOT_EXIST");
        require(!s.graduated, "SALE_GRADUATED");
        _;
    }

    /* ============ Constructor ============ */
    /// @param uniswapFactory_ Uniswap V2 Factory address
    /// @param weth_ WGAS10 address
    constructor(address uniswapFactory_, address weth_) {
        uniswapFactory = uniswapFactory_;
        weth = weth_;
    }

    /* ============ Create Sale ============ */
    /// @inheritdoc IDuo
    function createSale(
        string calldata name,
        string calldata symbol,
        uint256 graduationBps,
        uint256 targetRaise,
        string calldata discord,
        string calldata x,
        string calldata telegram,
        string calldata repoUrl
    ) external returns (address token) {
        require(bytes(discord).length <= 128, "discord too long");
        require(bytes(x).length <= 128, "x too long");
        require(bytes(telegram).length <= 128, "telegram too long");
        require(bytes(repoUrl).length <= 256, "repoUrl too long");
        token = _createSale(name, symbol, graduationBps, targetRaise, msg.sender);
        emit SaleCreated(msg.sender, token, name, symbol, discord, x, telegram, repoUrl);
    }

    /* ============ Buy ============ */
    /// @inheritdoc IDuo
    function buy(address token, uint256 minTokensOut)
        external
        payable
        saleActive(token)
        nonReentrant
        returns (uint256 tokensOut)
    {
        require(msg.value > 0, "ZERO_GAS");
        tokensOut = _buy(token, msg.value, minTokensOut, msg.sender);
    }

    /* ============ Create and Buy ============ */
    /// @notice Atomically create a sale and immediately buy into it, eliminating
    ///         same-block sniping risk on the creation transaction itself.
    function createAndBuy(
        string calldata name,
        string calldata symbol,
        uint256 graduationBps,
        uint256 targetRaise,
        uint256 minTokensOut,
        string calldata discord,
        string calldata x,
        string calldata telegram,
        string calldata repoUrl
    ) external payable nonReentrant returns (address token, uint256 tokensOut) {
        require(msg.value > 0, "ZERO_GAS");
        require(bytes(discord).length <= 128, "discord too long");
        require(bytes(x).length <= 128, "x too long");
        require(bytes(telegram).length <= 128, "telegram too long");
        require(bytes(repoUrl).length <= 256, "repoUrl too long");
        token = _createSale(name, symbol, graduationBps, targetRaise, msg.sender);
        emit SaleCreated(msg.sender, token, name, symbol, discord, x, telegram, repoUrl);
        tokensOut = _buy(token, msg.value, minTokensOut, msg.sender);
    }

    /* ============ Sell ============ */
    /// @inheritdoc IDuo
    function sell(address token, uint256 tokensIn, uint256 minGASOut)
        external
        saleActive(token)
        nonReentrant
        returns (uint256 GASOut)
    {
        SaleInfo storage s = sales[token];
        require(tokensIn > 0, "ZERO_TOKENS");

        // 1. Calculate current virtual reserves
        uint256 GASReserve   = s.virtualGAS + s.GASRaised;
        uint256 tokenReserve = s.virtualToken - s.tokensSold;

        // 2. Calculate GAS due
        GASOut = CurveMath.getAmountOut(tokenReserve, GASReserve, tokensIn);
        require(GASOut > 0, "ZERO_GAS");
        require(GASOut >= minGASOut, "SLIPPAGE");
        require(GASOut <= s.GASRaised, "INSUFFICIENT_GAS");

        // 3. Update state (Checks-Effects-Interactions: state before external calls)
        s.tokensSold -= tokensIn;
        s.GASRaised  -= GASOut;

        // 4. Transfer tokens from seller
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);

        // 5. Transfer GAS to seller (gas limited to prevent griefing)
        (bool ok, ) = msg.sender.call{value: GASOut, gas: 100_000}("");
        require(ok, "GAS_TRANSFER_FAILED");

        emit TokensSold(msg.sender, token, tokensIn, GASOut);
    }

    /* ============ Internal: Create Sale ============ */
    /// @dev Shared core logic for createSale() and createAndBuy(). Deploys the token,
    ///      computes virtual reserves, and stores the SaleInfo.
    function _createSale(
        string calldata name,
        string calldata symbol,
        uint256 graduationBps,
        uint256 targetRaise,
        address creator
    ) internal returns (address token) {
        require(graduationBps >= Constants.MIN_GRADUATION_BPS, "INVALID_GRADUATION_MIN");
        require(graduationBps <= Constants.MAX_GRADUATION_BPS, "INVALID_GRADUATION_MAX");
        require(targetRaise > 0, "INVALID_TARGET_RAISE");

        // Deploy token, all supply goes to this contract
        token = address(new TokenTemplate(
            name,
            symbol,
            Constants.TOTAL_SUPPLY,
            address(this)
        ));

        // Calculate virtual pool parameters (P = p / BPS_DENOM)
        // vToken = T * p² / BPS_DENOM / (2p - BPS_DENOM)
        // vGAS   = R * (BPS_DENOM - p) / (2p - BPS_DENOM)
        uint256 p = graduationBps;
        require(2 * p > Constants.BPS_DENOMINATOR, "INVALID_GRADUATION");
        uint256 twoPminusOne = 2 * p - Constants.BPS_DENOMINATOR;

        uint256 pSquared = p * p;
        uint256 vToken = Constants.TOTAL_SUPPLY * pSquared / (Constants.BPS_DENOMINATOR * twoPminusOne);
        uint256 vGAS   = targetRaise * (Constants.BPS_DENOMINATOR - p) / twoPminusOne;
        require(vGAS > 0 && vToken > 0, "INVALID_TARGET_RAISE");

        sales[token] = SaleInfo({
            creator: creator,
            tokensSold: 0,
            GASRaised: 0,
            targetRaise: targetRaise,
            virtualGAS: vGAS,
            virtualToken: vToken,
            graduationBps: p,
            graduated: false
        });
    }

    /* ============ Internal: Buy ============ */
    /// @dev Shared core logic for buy() and createAndBuy(). Assumes the caller has already
    ///      verified saleActive (buy() via modifier; createAndBuy() by construction, since
    ///      the sale was just created in the same transaction).
    function _buy(address token, uint256 GASIn, uint256 minTokensOut, address buyer)
        internal
        returns (uint256 tokensOut)
    {
        SaleInfo storage s = sales[token];

        // 1. Calculate current virtual reserves
        uint256 GASReserve   = s.virtualGAS + s.GASRaised;
        uint256 tokenReserve = s.virtualToken - s.tokensSold;
        require(tokenReserve > 0, "NO_TOKENS_LEFT");

        // 2. Calculate tokens due
        tokensOut = CurveMath.getAmountOut(GASReserve, tokenReserve, GASIn);
        require(tokensOut > 0, "ZERO_TOKENS");

        // 3. Prevent buying all before graduation, cap at graduation point (P * T)
        uint256 maxTokens = Constants.TOTAL_SUPPLY * s.graduationBps / Constants.BPS_DENOMINATOR;
        uint256 remainingToGrad = maxTokens - s.tokensSold;
        uint256 refund = 0;
        uint256 GASInOriginal = GASIn;
        if (tokensOut > remainingToGrad) {
            tokensOut = remainingToGrad;
            GASIn = CurveMath.getAmountIn(GASReserve, tokenReserve, tokensOut);
            refund = GASInOriginal - GASIn;
        }

        // The minimum output must apply to the final, capped output.  Checking
        // before the cap would let a buy succeed with fewer tokens than the
        // caller explicitly required when it triggers graduation.
        require(tokensOut >= minTokensOut, "SLIPPAGE");

        // 4. Update state (Checks-Effects-Interactions: state changes before external calls)
        s.tokensSold += tokensOut;
        s.GASRaised  += GASIn;

        // 5. Transfer tokens to buyer
        IERC20(token).safeTransfer(buyer, tokensOut);

        // 6. Refund overpaid GAS (after state changes, gas limited to prevent griefing)
        if (refund > 0) {
            (bool ok, ) = buyer.call{value: refund, gas: 100_000}("");
            require(ok, "REFUND_FAILED");
        }

        emit TokensPurchased(buyer, token, GASIn, tokensOut);

        // 7. The token allocation is the single graduation boundary. targetRaise
        //    configures the curve and its expected proceeds, while this condition
        //    keeps the sold supply deterministic despite integer rounding.
        if (s.tokensSold >= maxTokens) {
            _graduate(token);
        }
    }

    /* ============ Graduation ============ */
    /// @dev On graduation:
    ///   - All remaining tokens go into the Uniswap V2 pool
    ///   - All raised GAS goes into the pool
    ///   - LP token sent to burn address (address(0)), ownership renounced
    ///   - No burn, virtual pool amplification ensures smooth price transition
    ///   - Bypasses Router to avoid front-running DoS via slippage checks
    function _graduate(address token) internal {
        SaleInfo storage s = sales[token];
        s.graduated = true;

        uint256 tokensForLP = Constants.TOTAL_SUPPLY - s.tokensSold;
        require(tokensForLP > 0, "NO_TOKENS_FOR_LP");
        uint256 GASForLP = s.GASRaised;
        require(GASForLP > 0, "NO_GAS_FOR_LP");

        // Ensure pair exists (createPair reverts if pair already exists)
        address pair = IUniswapV2Factory(uniswapFactory).getPair(token, weth);
        if (pair == address(0)) {
            IUniswapV2Factory(uniswapFactory).createPair(token, weth);
            pair = IUniswapV2Factory(uniswapFactory).getPair(token, weth);
        }
        require(pair != address(0), "PAIR_NOT_CREATED");

        // 1. Wrap GAS to WGAS
        IWETH(weth).deposit{value: GASForLP}();

        // 2. Transfer token and WGAS to pair
        IERC20(token).safeTransfer(pair, tokensForLP);
        IERC20(weth).safeTransfer(pair, GASForLP);

        // 3. Mint LP tokens to burn address (locks liquidity permanently)
        IUniswapV2Pair(pair).mint(address(0));

        emit SaleGraduated(token, pair, tokensForLP, GASForLP);
    }


    /// @inheritdoc IDuo
    function getSale(address token) external view returns (
        address creator,
        uint256 tokensSold,
        uint256 GASRaised,
        uint256 targetRaise,
        uint256 virtualGAS,
        uint256 virtualToken,
        uint256 graduationBps,
        bool    graduated
    ) {
        SaleInfo storage s = sales[token];
        require(s.creator != address(0), "SALE_NOT_EXIST");
        return (s.creator, s.tokensSold, s.GASRaised,
                s.targetRaise, s.virtualGAS, s.virtualToken, s.graduationBps, s.graduated);
    }

    /// @inheritdoc IDuo
    function getCurrentPrice(address token) external view returns (uint256) {
        SaleInfo storage s = sales[token];
        require(s.creator != address(0), "SALE_NOT_EXIST");
        require(!s.graduated, "SALE_GRADUATED");
        uint256 GASReserve   = s.virtualGAS + s.GASRaised;
        uint256 tokenReserve = s.virtualToken - s.tokensSold;
        require(tokenReserve > 0, "NO_TOKENS");
        // Price = GASReserve / tokenReserve * 1e18
        return GASReserve * 1e18 / tokenReserve;
    }

    /// @inheritdoc IDuo
    function getTokensForGAS(address token, uint256 GASAmount) external view returns (uint256) {
        SaleInfo storage s = sales[token];
        require(s.creator != address(0), "SALE_NOT_EXIST");
        require(!s.graduated, "SALE_GRADUATED");
        uint256 GASReserve   = s.virtualGAS + s.GASRaised;
        uint256 tokenReserve = s.virtualToken - s.tokensSold;
        uint256 tokensOut = CurveMath.getAmountOut(GASReserve, tokenReserve, GASAmount);

        // Mirror buy(): no quote can exceed the amount still sellable before
        // graduation.  Any GAS beyond that amount is refunded by buy().
        uint256 maxTokens = Constants.TOTAL_SUPPLY * s.graduationBps / Constants.BPS_DENOMINATOR;
        uint256 remainingToGrad = maxTokens - s.tokensSold;
        return tokensOut > remainingToGrad ? remainingToGrad : tokensOut;
    }

    /// @inheritdoc IDuo
    function getGASForTokens(address token, uint256 tokenAmount) external view returns (uint256) {
        SaleInfo storage s = sales[token];
        require(s.creator != address(0), "SALE_NOT_EXIST");
        require(!s.graduated, "SALE_GRADUATED");
        uint256 GASReserve   = s.virtualGAS + s.GASRaised;
        uint256 tokenReserve = s.virtualToken - s.tokensSold;
        return CurveMath.getAmountOut(tokenReserve, GASReserve, tokenAmount);
    }

    /* ============ Receive ============ */
    /// @dev No receive needed - buy() handles GAS, graduation wraps GAS to WGAS directly
    receive() external payable {
        revert("USE_BUY_FUNCTION");
    }
}
