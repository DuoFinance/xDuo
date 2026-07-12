// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "../interfaces/IUniswapV2Factory.sol";
import "../interfaces/IUniswapV2Router02.sol";

contract DuoBondingCurve is ERC20, ReentrancyGuard {
    IUniswapV2Router02 public immutable router;
    IUniswapV2Factory public immutable factory;

    uint256 public immutable gradient;
    uint256 public immutable targetReserve;

    uint256 public curveSupply;
    uint256 public curveReserve;
    bool public graduated;
    address public pair;

    event Purchased(address indexed buyer, uint256 amount, uint256 cost);
    event Sold(address indexed seller, uint256 amount, uint256 proceeds);
    event Graduated(address indexed pair, uint256 tokenAmount, uint256 ethAmount);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 gradient_,
        uint256 targetReserve_,
        address router_,
        address factory_
    ) ERC20(name_, symbol_) {
        require(gradient_ > 0, "ZERO_GRADIENT");
        require(targetReserve_ > 0, "ZERO_TARGET");
        gradient = gradient_;
        targetReserve = targetReserve_;
        router = IUniswapV2Router02(router_);
        factory = IUniswapV2Factory(factory_);
    }

    /// @notice Buy tokens along the bonding curve.
    /// Price follows a linear curve: P(supply) = gradient * supply / 1e18
    /// Cost to mint `amount` tokens at supply S:
    ///   cost = gradient * (2*S*amount + amount²) / (2 * 1e36)
    function buy() external payable nonReentrant {
        require(!graduated, "GRADUATED");
        require(msg.value > 0, "ZERO_AMOUNT");

        uint256 newReserve = curveReserve + msg.value;
        if (newReserve > targetReserve) {
            newReserve = targetReserve;
        }

        uint256 cost = newReserve - curveReserve;

        // amount = sqrt(supply² + 2*1e36*cost/gradient) - supply
        uint256 term = (2 * 1e36 * cost) / gradient;
        uint256 inside = curveSupply * curveSupply + term;
        uint256 newSupply = Math.sqrt(inside);
        uint256 amount = newSupply - curveSupply;
        require(amount > 0, "AMOUNT_TOO_SMALL");

        uint256 excess = msg.value - cost;

        _mint(msg.sender, amount);
        curveSupply = newSupply;
        curveReserve = newReserve;

        if (excess > 0) {
            (bool success, ) = payable(msg.sender).call{value: excess}("");
            require(success, "REFUND_FAILED");
        }

        emit Purchased(msg.sender, amount, cost);

        if (curveReserve >= targetReserve) {
            _graduate();
        }
    }

    /// @notice Sell tokens back to the bonding curve.
    /// proceeds = gradient * (2*S*amount - amount²) / (2 * 1e36)
    function sell(uint256 amount) external nonReentrant {
        require(!graduated, "GRADUATED");
        require(amount > 0, "ZERO_AMOUNT");
        require(balanceOf(msg.sender) >= amount, "INSUFFICIENT_BALANCE");
        require(amount <= curveSupply, "EXCEEDS_CURVE_SUPPLY");

        // proceeds = K * (2*S*amount - amount²) / (2 * 1e36)
        uint256 proceeds = gradient * (2 * curveSupply * amount - amount * amount) / (2 * 1e36);

        _burn(msg.sender, amount);
        curveSupply -= amount;
        curveReserve -= proceeds;

        (bool success, ) = payable(msg.sender).call{value: proceeds}("");
        require(success, "ETH_TRANSFER_FAILED");

        emit Sold(msg.sender, amount, proceeds);
    }

    /// @notice Migrate liquidity to Uniswap V2 once targetReserve is reached.
    function _graduate() internal {
        if (graduated) return;
        graduated = true;

        address weth = router.WETH();
        pair = factory.createPair(address(this), weth);

        // tokenLiquidity = curveSupply / 2 creates a Uniswap V2 pool where
        // eth_reserve / token_reserve = final curve marginal price.
        uint256 tokenLiquidity = curveSupply / 2;
        uint256 ethLiquidity = curveReserve;

        _mint(address(this), tokenLiquidity);
        _approve(address(this), address(router), tokenLiquidity);

        (uint256 amountToken, uint256 amountETH, ) = router.addLiquidityETH{value: ethLiquidity}(
            address(this),
            tokenLiquidity,
            tokenLiquidity,
            ethLiquidity,
            address(0),
            block.timestamp + 15 minutes
        );

        emit Graduated(pair, amountToken, amountETH);
    }

    // --- View helpers ---

    /// @notice Current marginal price in wei per token.
    function getPrice() external view returns (uint256) {
        if (curveSupply == 0) return 0;
        return gradient * curveSupply / 1e18;
    }

    /// @notice Cost to buy `amount` tokens at current supply.
    function getBuyCost(uint256 amount) external view returns (uint256) {
        if (graduated) return 0;
        return gradient * (2 * curveSupply * amount + amount * amount) / (2 * 1e36);
    }

    /// @notice Proceeds from selling `amount` tokens at current supply.
    function getSellReturn(uint256 amount) external view returns (uint256) {
        if (graduated || amount > curveSupply) return 0;
        return gradient * (2 * curveSupply * amount - amount * amount) / (2 * 1e36);
    }

    receive() external payable {}
}
