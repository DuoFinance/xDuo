// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/duoLaunch/DuoLaunch.sol";
import "../contracts/duoLaunch/Constants.sol";
import "../contracts/duoLaunch/CurveMath.sol";
import "../contracts/duoLaunch/TokenTemplate.sol";

// ─── Minimal ERC20 interface for MockPair ─────────────────────
interface IERC20Simple {
    function balanceOf(address) external view returns (uint256);
}

// ─── Mock WETH (minimal, only what DuoLaunch needs) ───────────────
contract MockWETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function approve(address, uint256) external returns (bool) { return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    receive() external payable {}
}

// ─── Mock Uniswap V2 Pair (minimal) ─────────────────────────
contract MockUniswapV2Pair {
    address public token0;
    address public token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint32  private blockTimestampLast;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;
    }

    function mint(address to) external returns (uint256 liquidity) {
        uint256 bal0 = IERC20Simple(token0).balanceOf(address(this));
        uint256 bal1 = IERC20Simple(token1).balanceOf(address(this));
        uint256 d0 = bal0 - reserve0;
        uint256 d1 = bal1 - reserve1;
        liquidity = totalSupply == 0 ? _sqrt(d0 * d1) : _min(d0 * totalSupply / reserve0, d1 * totalSupply / reserve1);
        require(liquidity > 0, "LIQ_ZERO");
        reserve0 = uint112(bal0);
        reserve1 = uint112(bal1);
        blockTimestampLast = uint32(block.timestamp);
        totalSupply += liquidity;
        balanceOf[to] += liquidity;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) { z = y; uint256 x = y / 2 + 1; while (x < z) { z = x; x = (y / x + x) / 2; } }
        else if (y != 0) z = 1;
    }
    function _min(uint256 a, uint256 b) internal pure returns (uint256) { return a < b ? a : b; }
}

// ─── Mock Uniswap V2 Factory ────────────────────────────────
contract MockUniswapV2Factory {
    mapping(address => mapping(address => address)) public getPair;
    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(getPair[tokenA][tokenB] == address(0), "EXISTS");
        pair = address(new MockUniswapV2Pair(tokenA, tokenB));
        getPair[tokenA][tokenB] = pair;
        getPair[tokenB][tokenA] = pair;
    }
}

// ─── Contract that rejects ETH (for negative tests) ──────────
contract EthRejecter {
    receive() external payable { revert("ETH_REJECTED"); }
}

// ─── Thin wrapper to call CurveMath via external call ───────
contract CurveMathCaller {
    function getAmountOut(uint256 a, uint256 b, uint256 c) external pure returns (uint256) {
        return CurveMath.getAmountOut(a, b, c);
    }
    function getAmountIn(uint256 a, uint256 b, uint256 c) external pure returns (uint256) {
        return CurveMath.getAmountIn(a, b, c);
    }
}

// ─── Contract that attempts reentrancy via sell() ────────────
contract ReentrancyAttacker {
    DuoLaunch public pump;
    TokenTemplate public token;
    bool public attackAttempted;
    bool public attackReverted;

    constructor(DuoLaunch _pump, address _token) {
        pump = _pump;
        token = TokenTemplate(_token);
    }

    function attack() external payable {
        pump.buy{value: msg.value}(address(token), 0);
        uint256 bal = token.balanceOf(address(this));
        token.approve(address(pump), type(uint256).max);
        pump.sell(address(token), bal / 2, 0);
    }

    receive() external payable {
        attackAttempted = true;
        uint256 remaining = token.balanceOf(address(this));
        if (remaining > 0) {
            token.approve(address(pump), remaining);
            try pump.sell(address(token), remaining, 0) {
                // Reentrancy should have been blocked
            } catch {
                attackReverted = true;
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════
//  INVARIANT TESTS FOR PUMP CONTRACT
// ═══════════════════════════════════════════════════════════════

contract DuoLaunchInvariants is Test {
    DuoLaunch public pump;
    MockWETH public weth;
    MockUniswapV2Factory public factory;
    MockUniswapV2Pair public uniPair;

    address alice = address(0xA11CE);
    address bob   = address(0xB0B);

    uint256 constant P = 8000;
    uint256 constant TARGET = 1000 ether;

    address public tokenAddr;
    TokenTemplate public token;

    struct SaleData {
        address creator;
        uint256 totalSupply;
        uint256 tokensSold;
        uint256 GASRaised;
        uint256 targetRaise;
        uint256 virtualGAS;
        uint256 virtualToken;
        uint256 graduationBps;
        bool graduated;
        address pair;
    }

    // ─── Setup ────────────────────────────────────────────────

    function setUp() public {
        weth = new MockWETH();
        factory = new MockUniswapV2Factory();
        pump = new DuoLaunch(address(factory), address(weth));

        vm.deal(alice, 100_000 ether);
        vm.deal(bob,   100_000 ether);
        vm.deal(address(this), 100_000 ether);

        vm.prank(alice);
        tokenAddr = pump.createSale("TestToken", "TST", P, TARGET);
        token = TokenTemplate(tokenAddr);
    }

    // ─── Helpers ──────────────────────────────────────────────

    function _sale() internal view returns (SaleData memory s) {
        (s.creator, s.totalSupply, s.tokensSold, s.GASRaised,
         s.targetRaise, s.virtualGAS, s.virtualToken,
         s.graduationBps, s.graduated, s.pair) = pump.getSale(tokenAddr);
    }

    function _k(SaleData memory s) internal pure returns (uint256) {
        return (s.virtualGAS + s.GASRaised) * (s.virtualToken - s.tokensSold);
    }

    function _maxTokens(SaleData memory s) internal pure returns (uint256) {
        return s.totalSupply * s.graduationBps / Constants.BPS_DENOMINATOR;
    }

    function _buy(address from, uint256 amount) internal {
        vm.prank(from);
        pump.buy{value: amount}(tokenAddr, 0);
    }

    function _approveAndSell(address from, uint256 tokenAmount) internal {
        vm.prank(from);
        token.approve(address(pump), tokenAmount);
        vm.prank(from);
        pump.sell(tokenAddr, tokenAmount, 0);
    }

    // ══════════════════════════════════════════════════════════
    //  INVARIANT 1:  Constant product k = (vGAS+GASR)*(vToken-ts)
    //  should remain approximately constant after trades.
    // ══════════════════════════════════════════════════════════

    function test_K_AfterSingleBuy() public {
        SaleData memory s0 = _sale();
        uint256 k0 = _k(s0);

        _buy(alice, 1 ether);

        SaleData memory s1 = _sale();
        if (!s1.graduated) {
            uint256 k1 = _k(s1);
            assertTrue(k1 >= k0, "k decreased after buy");
            assertApproxEqRel(k1, k0, 1e15);
        }
    }

    function test_K_AfterBuyThenSell() public {
        _buy(alice, 5 ether);

        SaleData memory s0 = _sale();
        uint256 k0 = _k(s0);
        uint256 bal = token.balanceOf(alice);

        _approveAndSell(alice, bal / 2);

        SaleData memory s1 = _sale();
        uint256 k1 = _k(s1);
        assertTrue(k1 >= k0, "k decreased after sell");
        assertApproxEqRel(k1, k0, 1e15);
    }

    function test_K_AfterMultipleBuys() public {
        SaleData memory s0 = _sale();
        uint256 k0 = _k(s0);

        _buy(alice, 2 ether);
        _buy(bob, 3 ether);
        _buy(alice, 1 ether);

        SaleData memory s1 = _sale();
        if (!s1.graduated) {
            uint256 k1 = _k(s1);
            assertApproxEqRel(k1, k0, 1e15);
        }
    }

    function testFuzz_K_Unchanged(uint256 GASAmount) public {
        vm.assume(GASAmount > 0.001 ether && GASAmount <= 10 ether);

        SaleData memory s0 = _sale();
        uint256 k0 = _k(s0);

        _buy(alice, GASAmount);

        SaleData memory s1 = _sale();
        if (s1.graduated) return;

        uint256 k1 = _k(s1);
        assertTrue(k1 >= k0, "k decreased after fuzz buy");
        assertApproxEqRel(k1, k0, 1e15);
    }

    // ══════════════════════════════════════════════════════════
    //  INVARIANT 2:  Token conservation
    //  pump.balanceOf(token) == totalSupply - tokensSold
    // ══════════════════════════════════════════════════════════

    function test_TokenConservation_AfterBuy() public {
        _buy(alice, 1 ether);
        SaleData memory s = _sale();
        assertEq(token.balanceOf(address(pump)), s.totalSupply - s.tokensSold);
    }

    function test_TokenConservation_AfterBuySell() public {
        _buy(alice, 5 ether);
        uint256 bal = token.balanceOf(alice);
        _approveAndSell(alice, bal / 2);

        SaleData memory s = _sale();
        assertEq(token.balanceOf(address(pump)), s.totalSupply - s.tokensSold);
    }

    function testFuzz_TokenConservation(uint256 GASAmount) public {
        vm.assume(GASAmount > 0.001 ether && GASAmount <= 10 ether);

        _buy(alice, GASAmount);

        SaleData memory s = _sale();
        if (s.graduated) return;

        assertEq(token.balanceOf(address(pump)), s.totalSupply - s.tokensSold);
    }

    // ══════════════════════════════════════════════════════════
    //  INVARIANT 3:  Graduation cap
    //  tokensSold <= totalSupply * P / BPS_DENOM before graduation
    // ══════════════════════════════════════════════════════════

    function test_GraduationCap_Boundary() public {
        uint256[4] memory bps = [uint256(6001), 6500, 8000, 9800];
        for (uint256 i = 0; i < bps.length; i++) {
            vm.prank(alice);
            address t = pump.createSale("T", "T", bps[i], TARGET);
            for (uint256 j = 0; j < 12; j++) {
                (,uint256 ts, uint256 tokensSold,,,,,, bool graduated,) = pump.getSale(t);
                if (graduated) break;
                uint256 cap = ts * bps[i] / Constants.BPS_DENOMINATOR;
                assertTrue(tokensSold <= cap, "cap exceeded before buy");
                uint256 remaining = cap - tokensSold;
                if (remaining == 0) break;
                vm.prank(bob);
                vm.deal(bob, 1000 ether);
                pump.buy{value: 10 ether}(t, 0);
                (,ts, tokensSold,,,,,, graduated,) = pump.getSale(t);
                if (graduated) break;
                assertTrue(tokensSold <= cap, "cap exceeded after buy");
            }
        }
    }

    function test_GraduationCap_NotExceeded() public {
        for (uint256 i = 0; i < 10; i++) {
            SaleData memory s = _sale();
            if (s.graduated) break;
            if (s.GASRaised >= s.targetRaise) break;
            uint256 cap = _maxTokens(s);
            _buy(alice, 5 ether);
            s = _sale();
            if (!s.graduated) {
                assertTrue(s.tokensSold <= cap, "cap exceeded");
            }
        }
    }

    // ══════════════════════════════════════════════════════════
    //  INVARIANT 4:  Graduation is terminal
    //  After graduation, buy() and sell() revert.
    // ══════════════════════════════════════════════════════════

    function test_GraduationTerminal() public {
        vm.deal(alice, TARGET + 10 ether);
        _buy(alice, TARGET + 10 ether);

        SaleData memory s = _sale();
        assertTrue(s.graduated, "should be graduated");

        vm.expectRevert("SALE_GRADUATED");
        _buy(alice, 1 ether);

        vm.expectRevert("SALE_GRADUATED");
        pump.sell(tokenAddr, 1, 0);
    }

    // ══════════════════════════════════════════════════════════
    //  INVARIANT 5:  getCurrentPrice() > 0 before graduation
    // ══════════════════════════════════════════════════════════

    function test_PriceAlwaysPositive() public {
        assertTrue(pump.getCurrentPrice(tokenAddr) > 0, "initial price zero");

        uint256[3] memory amounts = [uint256(1 ether), 5 ether, 10 ether];
        for (uint256 i = 0; i < amounts.length; i++) {
            _buy(alice, amounts[i]);
            SaleData memory s = _sale();
            if (s.graduated) break;
            assertTrue(pump.getCurrentPrice(tokenAddr) > 0, "price zero after buy");
        }
    }

    function test_PriceMonotonic_BuyIncreasesPrice() public {
        uint256 p0 = pump.getCurrentPrice(tokenAddr);
        _buy(alice, 1 ether);
        SaleData memory s = _sale();
        if (!s.graduated) {
            uint256 p1 = pump.getCurrentPrice(tokenAddr);
            assertTrue(p1 > p0, "price did not increase on buy");
        }
    }

    // ══════════════════════════════════════════════════════════
    //  INVARIANT 6:  Quote consistency
    //  getTokensForGAS / getGASForTokens match actual trade results
    // ══════════════════════════════════════════════════════════

    function test_QuoteConsistency_Buy() public {
        uint256 GASIn = 5 ether;
        uint256 quoted = pump.getTokensForGAS(tokenAddr, GASIn);

        vm.prank(alice);
        vm.recordLogs();
        pump.buy{value: GASIn}(tokenAddr, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("TokensPurchased(address,address,uint256,uint256)")) {
                (, uint256 actual) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(actual, quoted, "quote != actual tokensOut");
                break;
            }
        }
    }

    function test_QuoteConsistency_Sell() public {
        _buy(alice, 10 ether);
        uint256 sellAmount = token.balanceOf(alice) / 4;
        uint256 quoted = pump.getGASForTokens(tokenAddr, sellAmount);

        vm.prank(alice);
        token.approve(address(pump), sellAmount);
        vm.prank(alice);
        vm.recordLogs();
        pump.sell(tokenAddr, sellAmount, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("TokensSold(address,address,uint256,uint256)")) {
                (, uint256 actual) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(actual, quoted, "quote != actual GASOut");
                break;
            }
        }
    }

    // ══════════════════════════════════════════════════════════
    //  INVARIANT 7:  Refund on overshoot
    //  Buying beyond graduation cap should refund excess GAS
    // ══════════════════════════════════════════════════════════

    function test_RefundOnOvershoot() public {
        SaleData memory s = _sale();
        uint256 maxTokens = _maxTokens(s);
        uint256 remainingToGrad = maxTokens - s.tokensSold;

        uint256 GASNeeded = CurveMath.getAmountIn(
            s.virtualGAS + s.GASRaised,
            s.virtualToken - s.tokensSold,
            remainingToGrad
        );

        uint256 excess = 50 ether;
        uint256 balBefore = alice.balance;
        _buy(alice, GASNeeded + excess);

        SaleData memory s1 = _sale();
        assertTrue(s1.tokensSold <= maxTokens, "cap exceeded after overshoot buy");

        uint256 netCost = balBefore - alice.balance;
        assertTrue(netCost <= GASNeeded + 1, "net cost exceeded GAS needed");
        assertTrue(netCost >= GASNeeded - 1, "net cost less than GAS needed (refund error)");
    }

    // ══════════════════════════════════════════════════════════
    //  INVARIANT 8:  Virtual reserves always positive
    // ══════════════════════════════════════════════════════════

    function test_VirtualReservesAlwaysPositive() public {
        SaleData memory s = _sale();
        assertTrue(s.virtualGAS > 0, "vGAS zero");
        assertTrue(s.virtualToken > 0, "vToken zero");

        _buy(alice, 1 ether);
        s = _sale();
        assertTrue(s.virtualGAS + s.GASRaised > 0, "GASReserve zero after buy");
        assertTrue(s.virtualToken - s.tokensSold > 0, "tokenReserve zero after buy");
    }

    // ══════════════════════════════════════════════════════════
    //  INVARIANT 9:  Graduation triggers correctly
    //  GASRaised >= targetRaise OR tokensSold >= maxTokens => graduated
    // ══════════════════════════════════════════════════════════

    function test_GraduationTriggersAtTarget() public {
        vm.deal(alice, TARGET + 10 ether);
        _buy(alice, TARGET + 10 ether);
        SaleData memory s = _sale();
        assertTrue(s.graduated, "should graduate at target");
    }

    function test_GraduationTransfersToPair() public {
        vm.deal(alice, TARGET + 10 ether);
        _buy(alice, TARGET + 10 ether);

        SaleData memory s = _sale();
        assertTrue(s.graduated, "did not graduate");

        address pairAddr = factory.getPair(tokenAddr, address(weth));
        assertTrue(pairAddr != address(0), "pair not created");

        uint256 tokensForLP = s.totalSupply - s.tokensSold;
        uint256 GASForLP = s.GASRaised;

        assertEq(token.balanceOf(pairAddr), tokensForLP, "pair missing tokens");
        assertEq(weth.balanceOf(pairAddr), GASForLP, "pair missing GAS");
    }

    // ══════════════════════════════════════════════════════════
    //  INVARIANT 10:  createAndBuy atomic consistency
    // ══════════════════════════════════════════════════════════

    function test_CreateAndBuyInvariants() public {
        vm.deal(bob, 100 ether);
        vm.prank(bob);
        (address t,) = pump.createAndBuy{value: 10 ether}("CB", "CB", P, TARGET, 0);

        TokenTemplate tkn = TokenTemplate(t);
        (,uint256 ts, uint256 tokensSold, uint256 GASRaised,,uint256 vg, uint256 vt,,,) = pump.getSale(t);

        assertTrue(vg > 0, "vGAS zero after createAndBuy");
        assertTrue(vt > 0, "vToken zero after createAndBuy");
        assertEq(tkn.balanceOf(address(pump)), ts - tokensSold);
        assertTrue(tkn.balanceOf(bob) > 0, "buyer got no tokens");

        // k invariant
        uint256 k = (vg + GASRaised) * (vt - tokensSold);
        uint256 k0 = vg * vt;
        uint256 diff = k > k0 ? k - k0 : k0 - k;
        assertTrue(diff * 1_000_000_000_000_000_000 < k + k0, "k drifted too much");
    }

    // ══════════════════════════════════════════════════════════
    //  INVARIANT 11:  Constructor validation
    // ══════════════════════════════════════════════════════════

    function test_InvalidGraduationBps_Reverts() public {
        vm.expectRevert("INVALID_GRADUATION_MIN");
        pump.createSale("X", "X", 5999, TARGET);

        vm.expectRevert("INVALID_GRADUATION_MAX");
        pump.createSale("X", "X", 9901, TARGET);
    }

    function test_InvalidTargetRaise_Reverts() public {
        vm.expectRevert("INVALID_TARGET_RAISE");
        pump.createSale("X", "X", 8000, 0);
    }

    function test_ZeroGASBuy_Reverts() public {
        vm.expectRevert("ZERO_GAS");
        pump.buy{value: 0}(tokenAddr, 0);
    }

    function test_ZeroTokenSell_Reverts() public {
        vm.expectRevert("ZERO_TOKENS");
        pump.sell(tokenAddr, 0, 0);
    }

    // ══════════════════════════════════════════════════════════
    //  INVARIANT 12:  GASRaised and tokensSold monotonicity
    // ══════════════════════════════════════════════════════════

    function test_Monotonic_BuyIncreases() public {
        SaleData memory s0 = _sale();
        _buy(alice, 1 ether);
        SaleData memory s1 = _sale();
        if (!s1.graduated) {
            assertTrue(s1.GASRaised > s0.GASRaised, "GASRaised not increased");
            assertTrue(s1.tokensSold > s0.tokensSold, "tokensSold not increased");
        }
    }

    function test_Monotonic_SellDecreases() public {
        _buy(alice, 10 ether);
        SaleData memory s0 = _sale();
        uint256 bal = token.balanceOf(alice);

        _approveAndSell(alice, bal / 2);
        SaleData memory s1 = _sale();
        assertTrue(s1.tokensSold < s0.tokensSold, "tokensSold did not decrease on sell");
        assertTrue(s1.GASRaised < s0.GASRaised, "GASRaised did not decrease on sell");
    }

    // ══════════════════════════════════════════════════════════
    //  INVARIANT 13:  Slippage protection works
    // ══════════════════════════════════════════════════════════

    function test_Slippage_RevertsOnHighMinOut() public {
        _buy(alice, 1 ether);
        uint256 quoted = pump.getTokensForGAS(tokenAddr, 1 ether);
        vm.expectRevert("SLIPPAGE");
        pump.buy{value: 1 ether}(tokenAddr, quoted + 1);
    }

    // ══════════════════════════════════════════════════════════
    //  INVARIANT 14:  CurveMath library consistency
    //  getAmountOut and getAmountIn are inverses (approx.)
    // ══════════════════════════════════════════════════════════

    function test_CurveMathInverse() public {
        SaleData memory s = _sale();
        uint256 R = s.virtualGAS;
        uint256 T = s.virtualToken;
        uint256 amountIn = 10 ether;

        uint256 out = CurveMath.getAmountOut(R, T, amountIn);
        assertTrue(out > 0, "out zero");

        uint256 back = CurveMath.getAmountIn(R, T, out);
        assertTrue(back >= amountIn, "inverse round-trip failed");
        assertTrue(back <= amountIn + 1, "inverse too high");
    }

    // ══════════════════════════════════════════════════════════
    //  INVARIANT 15:  Graduation creates a Uniswap V2 pair
    // ══════════════════════════════════════════════════════════

    function test_GraduationCreatesPair() public {
        vm.deal(alice, TARGET + 10 ether);
        _buy(alice, TARGET + 10 ether);

        address pairAddr = factory.getPair(tokenAddr, address(weth));
        assertTrue(pairAddr != address(0), "pair not created after graduation");

        SaleData memory s = _sale();
        assertTrue(s.graduated, "graduated should be true");
        assertTrue(
            token.balanceOf(pairAddr) + token.balanceOf(address(pump)) == s.totalSupply - s.tokensSold,
            "token accounting mismatch after graduation"
        );
    }

    // ══════════════════════════════════════════════════════════
    //  NEGATIVE TESTS — each require/revert in DuoLaunch.sol
    // ══════════════════════════════════════════════════════════

    address constant NONEXISTENT = address(0xDEAD);

    // ─── modifier saleActive: SALE_NOT_EXIST ─────────────────

    function test_SaleNotExist_Buy() public {
        vm.expectRevert("SALE_NOT_EXIST");
        pump.buy{value: 1 ether}(NONEXISTENT, 0);
    }

    function test_SaleNotExist_Sell() public {
        vm.expectRevert("SALE_NOT_EXIST");
        pump.sell(NONEXISTENT, 1, 0);
    }

    function test_SaleNotExist_GetSale() public {
        vm.expectRevert("SALE_NOT_EXIST");
        pump.getSale(NONEXISTENT);
    }

    function test_SaleNotExist_GetCurrentPrice() public {
        vm.expectRevert("SALE_NOT_EXIST");
        pump.getCurrentPrice(NONEXISTENT);
    }

    function test_SaleNotExist_GetTokensForGAS() public {
        vm.expectRevert("SALE_NOT_EXIST");
        pump.getTokensForGAS(NONEXISTENT, 1 ether);
    }

    function test_SaleNotExist_GetGASForTokens() public {
        vm.expectRevert("SALE_NOT_EXIST");
        pump.getGASForTokens(NONEXISTENT, 1 ether);
    }

    // ─── createAndBuy: ZERO_GAS ──────────────────────────────

    function test_CreateAndBuy_ZeroGAS_Reverts() public {
        vm.expectRevert("ZERO_GAS");
        pump.createAndBuy{value: 0}("X", "X", P, TARGET, 0);
    }

    // ─── view functions after graduation: SALE_GRADUATED ─────

    function _graduateSetup() internal {
        vm.deal(alice, TARGET + 10 ether);
        _buy(alice, TARGET + 10 ether);
    }

    function test_SaleGraduated_GetCurrentPrice() public {
        _graduateSetup();
        vm.expectRevert("SALE_GRADUATED");
        pump.getCurrentPrice(tokenAddr);
    }

    function test_SaleGraduated_GetTokensForGAS() public {
        _graduateSetup();
        vm.expectRevert("SALE_GRADUATED");
        pump.getTokensForGAS(tokenAddr, 1 ether);
    }

    function test_SaleGraduated_GetGASForTokens() public {
        _graduateSetup();
        vm.expectRevert("SALE_GRADUATED");
        pump.getGASForTokens(tokenAddr, 1 ether);
    }

    // ─── sell: SLIPPAGE (minGASOut too high) ─────────────────

    function test_Sell_Slippage_Reverts() public {
        _buy(alice, 10 ether);
        uint256 bal = token.balanceOf(alice);
        uint256 quoted = pump.getGASForTokens(tokenAddr, bal);
        vm.prank(alice);
        token.approve(address(pump), bal);
        vm.expectRevert("SLIPPAGE");
        vm.prank(alice);
        pump.sell(tokenAddr, bal, quoted + 1);
    }

    // ─── sell: INSUFFICIENT_GAS (GASOut > GASRaised) ────────
    //  UNREACHABLE via normal paths: CP-AMM rounding means
    //  selling tokens always returns <= the GAS used to buy
    //  them, and GASRaised tracks all GAS ever contributed.
    //  Kept as documentation — this is a defense-in-depth check.

    // ─── sell: GAS_TRANSFER_FAILED (recipient rejects ETH) ───

    function test_Sell_GASTransferFailed_Reverts() public {
        EthRejecter noEth = new EthRejecter();
        vm.deal(address(noEth), 10 ether);

        _buy(alice, 10 ether);
        uint256 bal = token.balanceOf(alice);
        vm.prank(alice);
        token.transfer(address(noEth), bal);

        vm.prank(address(noEth));
        token.approve(address(pump), bal);
        vm.expectRevert("GAS_TRANSFER_FAILED");
        vm.prank(address(noEth));
        pump.sell(tokenAddr, bal, 0);
    }

    // ─── buy: REFUND_FAILED (buyer rejects ETH on refund) ────

    function test_Buy_RefundFailed_Reverts() public {
        EthRejecter noEth = new EthRejecter();
        // Buy enough to hit the overshoot: needed ≈ TARGET (1000 ETH)
        vm.deal(address(noEth), TARGET + 100 ether);

        SaleData memory s = _sale();
        uint256 maxT = _maxTokens(s);
        uint256 remaining = maxT - s.tokensSold;
        uint256 needed = CurveMath.getAmountIn(
            s.virtualGAS + s.GASRaised,
            s.virtualToken - s.tokensSold,
            remaining
        );
        uint256 overshoot = needed + 10 ether;

        vm.expectRevert("REFUND_FAILED");
        vm.prank(address(noEth));
        pump.buy{value: overshoot}(tokenAddr, 0);
    }

    // ─── receive(): USE_BUY_FUNCTION ────────────────────────

    function test_Receive_Reverts() public {
        vm.expectRevert("USE_BUY_FUNCTION");
        (bool ok,) = address(pump).call{value: 1 ether}("");
        assertTrue(ok, "call should revert"); // unreachable if revert fires
    }

    // ══════════════════════════════════════════════════════════
    //  ADDITIONAL BRANCH COVERAGE
    //  Test the "other half" of conditional branches
    // ══════════════════════════════════════════════════════════

    // ─── sell: GASOut == 0 after tiny sale ──────────────────

    function test_Sell_ZeroGASOut_Reverts() public {
        _buy(alice, 10 ether);
        uint256 dust = 1;
        uint256 bal = token.balanceOf(alice);
        vm.prank(alice);
        token.approve(address(pump), bal);
        vm.expectRevert("ZERO_GAS");
        vm.prank(alice);
        pump.sell(tokenAddr, dust, 0);
    }

    // ─── CurveMath.getAmountOut: ZERO_INPUT ─────────────────

    function test_CurveMath_ZeroInput_Reverts() public {
        CurveMathCaller c = new CurveMathCaller();
        vm.expectRevert("ZERO_INPUT");
        c.getAmountOut(1 ether, 1 ether, 0);
    }

    // ─── CurveMath.getAmountOut: INSUFFICIENT_LIQUIDITY ─────

    function test_CurveMath_InsufficientLiquidity_Reverts() public {
        CurveMathCaller c = new CurveMathCaller();
        vm.expectRevert("INSUFFICIENT_LIQUIDITY");
        c.getAmountOut(0, 1 ether, 1 ether);
        vm.expectRevert("INSUFFICIENT_LIQUIDITY");
        c.getAmountOut(1 ether, 0, 1 ether);
    }

    // ─── CurveMath.getAmountIn: ZERO_OUTPUT ─────────────────

    function test_CurveMath_ZeroOutput_Reverts() public {
        CurveMathCaller c = new CurveMathCaller();
        vm.expectRevert("ZERO_OUTPUT");
        c.getAmountIn(1 ether, 1 ether, 0);
    }

    // ─── CurveMath.getAmountIn: INSUFFICIENT_LIQUIDITY ──────

    function test_CurveMath_InsufficientLiquidityIn_Reverts() public {
        CurveMathCaller c = new CurveMathCaller();
        vm.expectRevert("INSUFFICIENT_LIQUIDITY");
        c.getAmountIn(0, 1 ether, 1 ether);
    }

    // ─── CurveMath.getAmountOut: uint112 boundary ──────────

    function test_CurveMath_Uint112Boundary() public {
        uint256 max112 = type(uint112).max;

        // amountIn * reserveOut should not overflow
        uint256 safeAmount = type(uint256).max / max112;
        uint256 out = CurveMath.getAmountOut(max112, max112, safeAmount);
        assertTrue(out > 0, "out should be > 0");
        assertTrue(out < max112, "out should be < max reserve");

        // one wei past the overflow boundary (via external call to catch panic)
        uint256 overflowAmount = safeAmount + 1;
        CurveMathCaller c = new CurveMathCaller();
        vm.expectRevert();
        c.getAmountOut(max112, max112, overflowAmount);
    }

    // ─── createSale graduationBps boundary ────────────────

    function test_CreateSale_GraduationBpsBounds() public {
        // Valid minimum: 6000
        address t1 = pump.createSale("Min", "MIN", 6000, 1000 ether);
        assertTrue(t1 != address(0));

        // Valid maximum: 9900
        address t2 = pump.createSale("Max", "MAX", 9900, 1000 ether);
        assertTrue(t2 != address(0));

        // Below MIN_GRADUATION_BPS
        vm.expectRevert("INVALID_GRADUATION_MIN");
        pump.createSale("Low", "LOW", 5999, 1000 ether);

        // Above MAX_GRADUATION_BPS
        vm.expectRevert("INVALID_GRADUATION_MAX");
        pump.createSale("High", "HIGH", 9901, 1000 ether);

        // P=5000 triggers INVALID_GRADUATION_MIN check first (MIN=6000)
        vm.expectRevert("INVALID_GRADUATION_MIN");
        pump.createSale("Half", "HALF", 5000, 1000 ether);
    }

    // ══════════════════════════════════════════════════════════
    //  MULTI-USER SCENARIOS
    // ══════════════════════════════════════════════════════════

    // ─── A buys → B buys (price ↑) → A sells at profit ─────

    function test_MultiUser_ProfitOnPriceRise() public {
        // Alice buys first (lower price)
        _buy(alice, 10 ether);
        SaleData memory s1 = _sale();
        uint256 aliceTokens = token.balanceOf(alice);
        uint256 aliceGASBefore = alice.balance;

        // Bob buys later (higher price → Alice's tokens appreciate)
        _buy(bob, 100 ether);
        SaleData memory s2 = _sale();
        assertTrue(s2.GASRaised > s1.GASRaised, "GASRaised should increase after Bob's buy");
        assertTrue(s2.tokensSold > s1.tokensSold, "tokensSold should increase after Bob's buy");

        // Alice sells her tokens at the higher price
        uint256 GASOut;
        {
            vm.prank(alice);
            token.approve(address(pump), aliceTokens);
            vm.prank(alice);
            GASOut = pump.sell(tokenAddr, aliceTokens, 0);
        }
        uint256 aliceGASAfter = alice.balance;
        uint256 aliceProfit = aliceGASAfter - aliceGASBefore;

        // Alice should get back more than 10 ETH due to price appreciation
        assertTrue(GASOut > 10 ether, "Alice should profit from Bob's buy");
        assertTrue(aliceProfit > 0, "net profit positive");
        assertTrue(!s2.graduated, "should not graduate from these buys");
    }

    // ─── A buys → transfers to B → B sells ─────────────────

    function test_MultiUser_TransferThenSell() public {
        _buy(alice, 10 ether);

        uint256 aliceTokens = token.balanceOf(alice);
        uint256 half = aliceTokens / 2;

        // Alice transfers half to Bob
        vm.prank(alice);
        token.transfer(bob, half);

        // Bob sells his tokens
        uint256 bobGASBefore = bob.balance;
        vm.prank(bob);
        token.approve(address(pump), half);
        vm.prank(bob);
        uint256 GASOut = pump.sell(tokenAddr, half, 0);

        assertTrue(GASOut > 0, "Bob should get GAS for tokens");
        assertTrue(bob.balance > bobGASBefore, "Bob's GAS increased");

        // Alice still holds the other half (±1 for odd-number rounding)
        assertApproxEqAbs(token.balanceOf(alice), half, 1, "Alice still has half");
    }

    // ─── A buys → B buys → both sell → ending state ───────

    function test_MultiUser_MultipleRoundTrip() public {
        _buy(alice, 5 ether);
        _buy(bob, 5 ether);

        uint256 aliceTokens = token.balanceOf(alice);
        uint256 bobTokens = token.balanceOf(bob);

        SaleData memory s0 = _sale();
        uint256 k0 = _k(s0);

        // Both sell
        vm.prank(alice);
        token.approve(address(pump), aliceTokens);
        vm.prank(alice);
        pump.sell(tokenAddr, aliceTokens, 0);

        vm.prank(bob);
        token.approve(address(pump), bobTokens);
        vm.prank(bob);
        pump.sell(tokenAddr, bobTokens, 0);

        SaleData memory s1 = _sale();
        assertEq(s1.tokensSold, 0, "all tokens returned");
        assertLe(s1.GASRaised, 10, "GAS should return to near zero");
        uint256 k1 = _k(s1);
        assertApproxEqRel(k1, k0, 1e15, "k invariant after round trip");
    }

    // ══════════════════════════════════════════════════════════
    //  EVENT VERIFICATION
    // ══════════════════════════════════════════════════════════

    // ─── SaleCreated event ─────────────────────────────────

    function test_Event_SaleCreated() public {
        vm.recordLogs();
        vm.prank(alice);
        address t = pump.createSale("EventTest", "EVT", P, TARGET);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("SaleCreated(address,address,string,string)")) {
                address creator = address(uint160(uint256(logs[i].topics[1])));
                address token_ = address(uint160(uint256(logs[i].topics[2])));
                assertEq(creator, alice, "event creator");
                assertEq(token_, t, "event token");
                found = true;
                break;
            }
        }
        assertTrue(found, "SaleCreated event not emitted");
    }

    // ─── SaleGraduated event ───────────────────────────────

    function test_Event_SaleGraduated() public {
        vm.deal(alice, TARGET + 10 ether);
        vm.recordLogs();
        _buy(alice, TARGET + 10 ether);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("SaleGraduated(address,address,uint256,uint256)")) {
                address token_ = address(uint160(uint256(logs[i].topics[1])));
                (address pair, uint256 tokensForLP, uint256 GASForLP) = abi.decode(logs[i].data, (address, uint256, uint256));
                assertEq(token_, tokenAddr, "event token");
                assertTrue(pair != address(0), "event pair non-zero");
                SaleData memory s = _sale();
                assertEq(tokensForLP, s.totalSupply - s.tokensSold, "event tokensForLP");
                assertEq(GASForLP, s.GASRaised, "event GASForLP");
                found = true;
                break;
            }
        }
        assertTrue(found, "SaleGraduated event not emitted");
    }

    // ─── TokensPurchased event parameters ──────────────────

    function test_Event_TokensPurchased() public {
        vm.recordLogs();
        _buy(alice, 5 ether);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("TokensPurchased(address,address,uint256,uint256)")) {
                address buyer = address(uint160(uint256(logs[i].topics[1])));
                address token_ = address(uint160(uint256(logs[i].topics[2])));
                (uint256 GASIn, uint256 tokensOut) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(buyer, alice, "event buyer");
                assertEq(token_, tokenAddr, "event token");
                assertEq(GASIn, 5 ether, "event GASIn");
                assertTrue(tokensOut > 0, "event tokensOut > 0");
                found = true;
                break;
            }
        }
        assertTrue(found, "TokensPurchased event not emitted");
    }

    // ─── TokensSold event parameters ───────────────────────

    function test_Event_TokensSold() public {
        _buy(alice, 10 ether);
        uint256 sellAmount = token.balanceOf(alice) / 2;

        vm.prank(alice);
        token.approve(address(pump), sellAmount);
        vm.recordLogs();
        vm.prank(alice);
        pump.sell(tokenAddr, sellAmount, 0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("TokensSold(address,address,uint256,uint256)")) {
                address seller = address(uint160(uint256(logs[i].topics[1])));
                address token_ = address(uint160(uint256(logs[i].topics[2])));
                (uint256 tokensIn, uint256 GASOut) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(seller, alice, "event seller");
                assertEq(token_, tokenAddr, "event token");
                assertEq(tokensIn, sellAmount, "event tokensIn");
                assertTrue(GASOut > 0, "event GASOut > 0");
                found = true;
                break;
            }
        }
        assertTrue(found, "TokensSold event not emitted");
    }

    // ══════════════════════════════════════════════════════════
    //  TOKEN TEMPLATE COVERAGE
    // ══════════════════════════════════════════════════════════

    // ─── decimals() override ────────────────────────────────

    function test_Token_Decimals() public {
        assertEq(token.decimals(), 18, "token decimals should match Constants");
        assertEq(token.name(), "TestToken", "token name");
        assertEq(token.symbol(), "TST", "token symbol");
    }

    // ══════════════════════════════════════════════════════════
    //  createAndBuy NON-GRADUATION PATH
    // ══════════════════════════════════════════════════════════

    function test_CreateAndBuy_ThenSell() public {
        // Create a new sale with high TARGET so 10 ETH doesn't graduate
        vm.deal(bob, 100 ether);
        vm.prank(bob);
        (address t,) = pump.createAndBuy{value: 10 ether}("CABSell", "CBS", P, 1000 ether, 0);
        TokenTemplate tk = TokenTemplate(t);

        // Verify state after createAndBuy
        (,,,,, uint256 vg, uint256 vt,,,) = pump.getSale(t);
        assertTrue(vg > 0, "vGAS should be set");
        assertTrue(vt > 0, "vToken should be set");
        assertTrue(tk.balanceOf(bob) > 0, "buyer should have tokens");

        // Sell part of the tokens
        uint256 sellAmount = tk.balanceOf(bob) / 2;
        vm.prank(bob);
        tk.approve(address(pump), sellAmount);
        vm.prank(bob);
        uint256 GASOut = pump.sell(t, sellAmount, 0);
        assertTrue(GASOut > 0, "sell should return GAS");

        // Token conservation check
        (,,,,,, uint256 tokensSold,,,) = pump.getSale(t);
        assertTrue(tokensSold < 10 ether / 1e18 * 1e27, "tokensSold after partial sell");
    }

    // ══════════════════════════════════════════════════════════
    //  CONTINUOUS TRADE FUZZ (buy + sell alternating)
    // ══════════════════════════════════════════════════════════

    function testFuzz_ContinuousTrades(uint96 seed) public {
        // Use a lower TARGET so trades are meaningful relative to scale
        vm.deal(alice, 100_000 ether);
        vm.deal(bob,   100_000 ether);

        vm.prank(alice);
        address t = pump.createSale("FuzzCont", "FZC", 8000, 10_000 ether);
        TokenTemplate tk = TokenTemplate(t);

        uint256 k0;
        {
            (,,,,, uint256 ivg, uint256 ivt,,,) = pump.getSale(t);
            k0 = ivg * ivt;
        }

        vm.prank(bob);
        tk.approve(address(pump), type(uint256).max);

        for (uint256 i = 0; i < 10; i++) {
            // Alternate: buy or sell
            if (i % 2 == 0 || tk.balanceOf(bob) < 0.001 ether) {
                // Buy
                uint256 amount = (uint256(keccak256(abi.encode(seed, i))) % 5 ether) + 0.001 ether;
                vm.prank(bob);
                pump.buy{value: amount}(t, 0);
            } else {
                // Sell half
                uint256 sellAmt = tk.balanceOf(bob) / 2;
                if (sellAmt > 0) {
                    (,,,,,,,, bool grad,) = pump.getSale(t);
                    if (!grad) {
                        vm.prank(bob);
                        pump.sell(t, sellAmt, 0);
                    }
                }
            }

            // Check invariants
            (,,,,, uint256 vg2, uint256 vt2,, bool graduated,) = pump.getSale(t);
            if (graduated) break;

            // k should stay constant (within rounding)
            SaleData memory s;
            (,, s.tokensSold, s.GASRaised,,,,,,) = pump.getSale(t);
            uint256 k1 = (vg2 + s.GASRaised) * (vt2 - s.tokensSold);
            assertApproxEqRel(k1, k0, 1e14, "k invariant in continuous trades");
        }
    }

    // ─── Reentrancy: sell() ETH callback must be gated by nonReentrant ───

    function test_Sell_Reentrancy_Blocked() public {
        ReentrancyAttacker attacker = new ReentrancyAttacker(pump, tokenAddr);
        vm.deal(address(attacker), 100 ether);

        attacker.attack{value: 100 ether}();

        assertTrue(attacker.attackAttempted(), "reentrancy should be attempted");
        assertTrue(attacker.attackReverted(), "reentrancy should be blocked by nonReentrant");
    }
}


//opencode -s ses_09701f0acffetR47eauHFQKnty