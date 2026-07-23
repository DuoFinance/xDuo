// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/duoLaunch/DuoLaunch.sol";
import "../contracts/duoLaunch/TokenTemplate.sol";
import "../contracts/duoLaunch/Constants.sol";
import "../contracts/duoLaunch/CurveMath.sol";

// ═══════════════════════════════════════════════════════════════
//  0.8.x V2 Interfaces — no V2 .sol source imported
// ═══════════════════════════════════════════════════════════════

interface IUniswapV2PairLike {
    function mint(address to) external returns (uint256 liquidity);
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

// ═══════════════════════════════════════════════════════════════
//  Minimal V2 implementations (pure 0.8.x, deployed on fork)
//  Uses real NeoX mainnet WGAS address — no WETH9 to deploy
// ═══════════════════════════════════════════════════════════════

interface IERC20Simple { function balanceOf(address) external view returns (uint256); }

contract UniswapV2Pair {
    address public token0;
    address public token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint32  private blockTimestampLast;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    uint256 constant MINIMUM_LIQUIDITY = 1000;

    constructor(address _token0, address _token1) {
        token0 = _token0; token1 = _token1;
    }

    function initialize(address, address) external {}

    function mint(address to) external returns (uint256 liquidity) {
        uint256 bal0 = IERC20Simple(token0).balanceOf(address(this));
        uint256 bal1 = IERC20Simple(token1).balanceOf(address(this));
        uint256 d0 = bal0 - reserve0;
        uint256 d1 = bal1 - reserve1;

        if (totalSupply == 0) {
            liquidity = _sqrt(d0 * d1) - MINIMUM_LIQUIDITY;
            _mint(address(0), MINIMUM_LIQUIDITY);
        } else {
            liquidity = _min(d0 * totalSupply / reserve0, d1 * totalSupply / reserve1);
        }
        require(liquidity > 0, "INSUFFICIENT_LIQ");
        reserve0 = uint112(bal0);
        reserve1 = uint112(bal1);
        blockTimestampLast = uint32(block.timestamp);
        _mint(to, liquidity);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount; balanceOf[to] += amount;
    }
    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) { z = y; uint256 x = y / 2 + 1; while (x < z) { z = x; x = (y / x + x) / 2; } }
        else if (y != 0) z = 1;
    }
    function _min(uint256 a, uint256 b) internal pure returns (uint256) { return a < b ? a : b; }
}

contract UniswapV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(getPair[tokenA][tokenB] == address(0), "EXISTS");
        require(tokenA != tokenB, "SAME");
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        pair = address(new UniswapV2Pair(t0, t1));
        getPair[t0][t1] = pair;
        getPair[t1][t0] = pair;
    }
}

// ═══════════════════════════════════════════════════════════════
//  INTEGRATION TEST — fork NeoX mainnet, test DuoLaunch graduation
// ═══════════════════════════════════════════════════════════════

contract DuoLaunchGraduationTest is Test {
    DuoLaunch public pump;
    address public constant WGAS = 0xdE41591ED1f8ED1484aC2CD8ca0876428de60EfF;
    UniswapV2Factory public factory;

    address alice = address(0xA11CE);
    address bob   = address(0xB0B);

    uint256 constant P = 8000;
    uint256 constant TARGET = 1000 ether;
    uint256 constant SMALL_TARGET = 1 ether;

    address public tokenAddr;
    TokenTemplate public token;

    struct SaleData {
        address creator; uint256 tokensSold; uint256 GASRaised;
        uint256 targetRaise; uint256 virtualGAS; uint256 virtualToken;
        uint256 graduationBps; bool graduated;
    }

    function setUp() public {
        // Fork NeoX mainnet (or use a local anvil fork)
        string memory rpc = vm.rpcUrl("neox_mainnet");
        vm.createSelectFork(rpc);

        // Deploy V2-compatible pair & factory (pure 0.8.x, no V2 source)
        // WGAS is already deployed on NeoX mainnet at the constant address
        factory = new UniswapV2Factory();

        // Deploy DuoLaunch using the real WGAS address
        pump = new DuoLaunch(address(factory), WGAS);

        vm.deal(alice, 10_000 ether);
        vm.deal(bob,   10_000 ether);
        vm.deal(address(this), 10_000 ether);
    }

    function _sale() internal view returns (SaleData memory s) {
        (s.creator, s.tokensSold, s.GASRaised,
         s.targetRaise, s.virtualGAS, s.virtualToken,
         s.graduationBps, s.graduated) = pump.getSale(tokenAddr);
    }

    function _buy(address from, uint256 amount) internal {
        vm.prank(from); pump.buy{value: amount}(tokenAddr, 0);
    }

    function _maxTokens(SaleData memory s) internal pure returns (uint256) {
        return Constants.TOTAL_SUPPLY * s.graduationBps / Constants.BPS_DENOMINATOR;
    }

    function _buyToGraduation(address from) internal {
        SaleData memory s = _sale();
        uint256 maxT = _maxTokens(s);
        uint256 remaining = maxT - s.tokensSold;
        uint256 GASIn = CurveMath.getAmountIn(
            s.virtualGAS + s.GASRaised,
            s.virtualToken - s.tokensSold,
            remaining
        );
        _buy(from, GASIn);
    }

    // ─── Scenario 1: targetRaise alone does not graduate ──────

    function test_Graduation_OnlyAfterTokenCap() public {
        // 999 ether is divisible by three. At P=80%, the virtual-reserve
        // rounding leaves this buy one token-wei below maxTokens while the
        // accounting targetRaise is already reached.
        uint256 target = 999 ether;
        vm.prank(alice);
        tokenAddr = pump.createSale("GradTest", "GRD", P, target, "", "", "", "");

        _buy(alice, target);

        SaleData memory beforeCap = _sale();
        uint256 maxT = _maxTokens(beforeCap);
        assertEq(beforeCap.GASRaised, target, "target raise should be reached");
        assertLt(beforeCap.tokensSold, maxT, "token cap should not yet be reached");
        assertFalse(beforeCap.graduated, "target raise alone must not graduate");

        // One more wei reaches the remaining token allocation and graduates.
        _buy(alice, 1);

        SaleData memory s = _sale();
        assertTrue(s.graduated, "should graduate at the token cap");
        assertEq(s.tokensSold, maxT, "must sell exactly maxTokens");

        // Verify pair created
        address pairAddr = factory.getPair(tokenAddr, WGAS);
        assertTrue(pairAddr != address(0), "pair not created");

        // Core graduation invariant: all remaining tokens + raised gas go to pair
        IUniswapV2PairLike pair = IUniswapV2PairLike(pairAddr);
        (uint112 r0, uint112 r1,) = pair.getReserves();

        address t0 = pair.token0();
        (uint112 uniToken, uint112 uniGAS) = t0 == tokenAddr ? (r0, r1) : (r1, r0);

        uint256 tokensForLP = Constants.TOTAL_SUPPLY - s.tokensSold;
        uint256 GASForLP = s.GASRaised;

        assertEq(uniToken, uint112(tokensForLP), "pair token reserve mismatch");
        assertEq(uniGAS,   uint112(GASForLP),     "pair gas reserve mismatch");

        // LP tokens burned to address(0)
        assertTrue(pair.balanceOf(address(0)) >= 1000, "MINIMUM_LIQUIDITY not burned");

        // Post-graduation: buy reverts
        vm.expectRevert("SALE_GRADUATED");
        _buy(alice, 1 ether);

        // Post-graduation: sell reverts
        vm.expectRevert("SALE_GRADUATED");
        pump.sell(tokenAddr, 1, 0);
    }

    // ─── Scenario 2:  Graduation by reaching token cap ─────────

    function test_Graduation_ByTokenCap() public {
        vm.prank(alice);
        tokenAddr = pump.createSale("CapTest", "CAP", P, TARGET, "", "", "", "");

        SaleData memory s0 = _sale();
        uint256 maxT = _maxTokens(s0);
        uint256 capGas = CurveMath.getAmountIn(
            s0.virtualGAS, s0.virtualToken, maxT
        );

        // Buy exactly the cap amount (this triggers graduation)
        _buy(alice, capGas);

        SaleData memory s = _sale();
        assertTrue(s.graduated, "should graduate via token cap");
        assertTrue(s.tokensSold >= maxT, "tokensSold should reach maxTokens");

        // Verify pair
        address pairAddr = factory.getPair(tokenAddr, WGAS);
        assertTrue(pairAddr != address(0), "pair not created on cap graduation");
    }

    // ─── Scenario 3:  Graduation with refund (overshoot) ──────

    function test_Graduation_WithRefund() public {
        vm.prank(alice);
        tokenAddr = pump.createSale("Refund", "REF", P, SMALL_TARGET, "", "", "", "");

        SaleData memory s0 = _sale();
        uint256 maxT = _maxTokens(s0);
        uint256 exactGas = CurveMath.getAmountIn(
            s0.virtualGAS, s0.virtualToken, maxT
        );

        uint256 overpay = 10 ether;
        uint256 balBefore = alice.balance;
        _buy(alice, exactGas + overpay);

        // Alice should get the overpay refunded (minus at most 1 wei rounding)
        uint256 spent = balBefore - alice.balance;
        assertTrue(spent <= exactGas + 1, "refund insufficient: overpay not returned");
        assertTrue(spent >= exactGas - 1, "too much refunded");

        SaleData memory s = _sale();
        assertTrue(s.graduated, "should graduate on overshoot buy");
    }

    // ─── Scenario 4:  Graduation with pre-existing pair ───────

    function test_Graduation_PreExistingPair() public {
        vm.prank(alice);
        tokenAddr = pump.createSale("PrePair", "PRE", P, SMALL_TARGET, "", "", "", "");
        token = TokenTemplate(tokenAddr);

        // Pre-create the pair and add minimal liquidity
        factory.createPair(tokenAddr, WGAS);
        address pairAddr = factory.getPair(tokenAddr, WGAS);
        assertTrue(pairAddr != address(0), "pair should exist before graduation");

        // Donate some tokens to the pair (simulating a front-runner)
        _buy(alice, 0.01 ether);
        uint256 someTokens = token.balanceOf(alice) / 10;
        vm.prank(alice);
        token.transfer(pairAddr, someTokens);

        // Graduation should still succeed (no DoS via pre-existing pair)
        _buyToGraduation(alice);

        SaleData memory s = _sale();
        assertTrue(s.graduated, "should graduate despite pre-existing pair");

        // LP mint should succeed
        IUniswapV2PairLike pair = IUniswapV2PairLike(pairAddr);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertTrue(r0 > 0 && r1 > 0, "reserves should be non-zero");
    }

    // ─── Scenario 5:  Graduation price continuity ─────────────

    function test_Graduation_PriceContinuity() public {
        vm.prank(alice);
        tokenAddr = pump.createSale("Price", "PRC", P, SMALL_TARGET, "", "", "", "");

        // Buy some tokens before graduation
        _buy(alice, 0.5 ether);

        // Graduate
        _buyToGraduation(alice);

        SaleData memory s = _sale();
        assertTrue(s.graduated, "should graduate");

        // Compute DuoLaunch closing price from final state
        uint256 closingGASReserve = s.virtualGAS + s.GASRaised;
        uint256 closingTokenReserve = s.virtualToken - s.tokensSold;
        uint256 pumpClosingPrice = closingGASReserve * 1e18 / closingTokenReserve;

        // Get Uniswap opening price
        address pairAddr = factory.getPair(tokenAddr, WGAS);
        IUniswapV2PairLike pair = IUniswapV2PairLike(pairAddr);
        (uint112 r0, uint112 r1,) = pair.getReserves();

        address t0 = pair.token0();
        (uint256 uniToken, uint256 uniGAS) = t0 == tokenAddr ? (r0, r1) : (r1, r0);
        uint256 uniPrice = uniGAS * 1e18 / uniToken;

        // DuoLaunch closing price should equal Uniswap opening price
        // (all remaining reserves + raised gas are transferred to the pair)
        uint256 diff = pumpClosingPrice > uniPrice ? pumpClosingPrice - uniPrice : uniPrice - pumpClosingPrice;
        assertTrue(diff * 1_000_000 < pumpClosingPrice + uniPrice, "price discontinuity across graduation");
    }

    // ─── Scenario 6:  Graduation boundary — minimum valid P ──

    function test_Graduation_MinimumP() public {
        uint256 minP = 6001;
        vm.prank(alice);
        tokenAddr = pump.createSale("MinP", "MINP", minP, SMALL_TARGET, "", "", "", "");

        _buyToGraduation(alice);

        SaleData memory s = _sale();
        assertTrue(s.graduated, "P=6001 should graduate");
        uint256 maxT = _maxTokens(s);
        assertTrue(s.tokensSold <= maxT, "cap check: P=6001");
    }

    // ─── Scenario 7:  Graduation boundary — maximum valid P ──

    function test_Graduation_MaximumP() public {
        uint256 maxP = 9900;
        vm.prank(alice);
        tokenAddr = pump.createSale("MaxP", "MAXP", maxP, SMALL_TARGET, "", "", "", "");

        _buyToGraduation(alice);

        SaleData memory s = _sale();
        assertTrue(s.graduated, "P=9900 should graduate");
    }

    // ─── Scenario 8:  Graduation via createAndBuy ─────────────

    function test_Graduation_CreateAndBuy() public {
        vm.prank(alice);
        (address t,) = pump.createAndBuy{value: SMALL_TARGET}(
            "CBGrad", "CBG", P, SMALL_TARGET, 0, "", "", "", ""
        );
        tokenAddr = t;
        token = TokenTemplate(tokenAddr);

        SaleData memory s = _sale();
        assertTrue(s.graduated, "createAndBuy should graduate when it sells the token cap");

        address pairAddr = factory.getPair(tokenAddr, WGAS);
        assertTrue(pairAddr != address(0), "pair should exist after createAndBuy grad");
    }

    // ─── Scenario 9:  Fuzz — random buy amounts until graduation ─
    // Runs: forge test --match-test testFuzz_Graduation -vvv

    function testFuzz_Graduation_RandomBuy(uint96 GASAmount) public {
        vm.assume(GASAmount > 0.001 ether && GASAmount <= 10 ether);

        vm.prank(alice);
        tokenAddr = pump.createSale("Fuzz", "FUZ", P, TARGET, "", "", "", "");
        token = TokenTemplate(tokenAddr);

        // Keep buying until graduation
        for (uint256 i = 0; i < 20; i++) {
            SaleData memory s = _sale();
            if (s.graduated) break;

            _buy(alice, GASAmount);

            s = _sale();
            if (s.graduated) {
                // Verify graduation state
                address pairAddr = factory.getPair(tokenAddr, WGAS);
                assertTrue(pairAddr != address(0), "pair must exist on grad");

                // All remaining tokens + gas transferred to pair
                IUniswapV2PairLike pair = IUniswapV2PairLike(pairAddr);
                (uint112 r0, uint112 r1,) = pair.getReserves();
                address t0 = pair.token0();
                (uint256 rToken, uint256 rGAS) = t0 == tokenAddr ? (r0, r1) : (r1, r0);
                assertEq(rToken, Constants.TOTAL_SUPPLY - s.tokensSold, "token reserves mismatch");
                assertTrue(rGAS > 0, "gas reserves should be > 0");
                return;
            }

            // Pre-graduation invariants
            assertTrue(s.tokensSold <= _maxTokens(s), "cap exceeded");
            assertTrue(s.virtualGAS + s.GASRaised > 0, "gas reserve zero");
            assertTrue(s.virtualToken - s.tokensSold > 0, "token reserve zero");
        }
    }

    // ─── Scenario 10:  Fuzz — random P & targetRaise parameters ─

    function testFuzz_Graduation_Params(uint16 P_, uint64 targetRaise_) public {
        vm.assume(P_ >= 6001 && P_ <= 9900);
        vm.assume(targetRaise_ >= 0.01 ether && targetRaise_ <= 10_000 ether);

        vm.prank(alice);
        tokenAddr = pump.createSale("FuzzP", "FZP", P_, targetRaise_, "", "", "", "");

        _buyToGraduation(alice);

        SaleData memory s = _sale();
        assertTrue(s.graduated, "should graduate for any valid P/target");
        assertTrue(s.tokensSold <= _maxTokens(s), "cap not exceeded");

        address pairAddr = factory.getPair(tokenAddr, WGAS);
        assertTrue(pairAddr != address(0), "pair must exist on grad");
    }
}
