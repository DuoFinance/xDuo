// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract RefundReentrant {
    address public pump;
    address public token;
    bool public entered;
    bool public ready;
    bool public reenterBuyBlocked;
    bool public reenterSellBlocked;
    bool public callbackTriggered;

    constructor(address pump_, address token_) {
        pump = pump_;
        token = token_;
        ready = true;
        reenterBuyBlocked = true;
        reenterSellBlocked = true;
    }

    receive() external payable {
        callbackTriggered = true;
        if (entered || !ready) return;
        entered = true;

        uint256 val = address(this).balance;
        (bool okBuy, ) = pump.call{value: val}(
            abi.encodeWithSignature("buy(address,uint256)", token, 0)
        );
        reenterBuyBlocked = !okBuy;

        uint256 tBal = IERC20(token).balanceOf(address(this));
        if (tBal > 0) {
            IERC20(token).approve(pump, tBal);
            (bool okSell, ) = pump.call(
                abi.encodeWithSignature("sell(address,uint256,uint256)", token, tBal, 0)
            );
            reenterSellBlocked = !okSell;
        }
    }

    function trigger(address token_) external payable {
        token = token_;
        (bool ok, ) = pump.call{value: msg.value}(
            abi.encodeWithSignature("buy(address,uint256)", token, 0)
        );
        require(ok, "BUY_FAILED");
    }
}

contract SellReentrant {
    address public pump;
    address public token;
    bool public entered;
    bool public ready;
    bool public reenterBuyBlocked;
    bool public reenterSellBlocked;
    bool public callbackTriggered;

    constructor(address pump_, address token_) {
        pump = pump_;
        token = token_;
        ready = false;
        reenterBuyBlocked = true;
        reenterSellBlocked = true;
    }

    function setReady(bool val) external { ready = val; }

    receive() external payable {
        callbackTriggered = true;
        if (entered || !ready) return;
        entered = true;

        uint256 val = address(this).balance;
        (bool okBuy, ) = pump.call{value: val}(
            abi.encodeWithSignature("buy(address,uint256)", token, 0)
        );
        reenterBuyBlocked = !okBuy;

        uint256 tBal = IERC20(token).balanceOf(address(this));
        if (tBal > 0) {
            IERC20(token).approve(pump, tBal);
            (bool okSell, ) = pump.call(
                abi.encodeWithSignature("sell(address,uint256,uint256)", token, tBal, 0)
            );
            reenterSellBlocked = !okSell;
        }
    }

    function trigger(uint256 sellAmount, uint256 minGas) external {
        IERC20(token).approve(pump, sellAmount);
        (bool ok, ) = pump.call(
            abi.encodeWithSignature("sell(address,uint256,uint256)", token, sellAmount, minGas)
        );
        require(ok, "SELL_FAILED");
    }
}

contract GraduationCrossReentrant {
    address public pump;
    address public factory;
    address public weth;
    address public token;
    bool public entered;
    bool public ready;
    bool public callbackTriggered;
    bool public pairPreCreated;
    bool public pairSeeded;
    bool public pumpBuyBlocked;
    bool public pumpSellBlocked;
    uint256 public attackerLP;

    function setReady(bool val) external { ready = val; }

    constructor(address pump_, address factory_, address weth_, address token_) {
        pump = pump_;
        factory = factory_;
        weth = weth_;
        token = token_;
        ready = false;
        pumpBuyBlocked = true;
        pumpSellBlocked = true;
    }

    receive() external payable {
        callbackTriggered = true;
        if (entered || !ready) return;
        entered = true;

        // Try to re-enter pump (should be blocked by nonReentrant)
        uint256 val = address(this).balance;
        if (val > 0) {
            (bool okBuy, ) = pump.call{value: val}(
                abi.encodeWithSignature("buy(address,uint256)", token, 0)
            );
            pumpBuyBlocked = !okBuy;
        }

        uint256 ptBal = IERC20(token).balanceOf(address(this));
        if (ptBal > 0) {
            (bool okSell, ) = pump.call(
                abi.encodeWithSignature("sell(address,uint256,uint256)", token, ptBal, 0)
            );
            pumpSellBlocked = !okSell;
        }
    }

    function trigger(address token_) external payable {
        token = token_;
        (bool ok, ) = pump.call{value: msg.value}(
            abi.encodeWithSignature("buy(address,uint256)", token, 0)
        );
        require(ok, "BUY_FAILED");
    }
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
}

interface IUniswapV2Factory {
    function getPair(address, address) external view returns (address);
    function createPair(address, address) external returns (address);
}

interface IUniswapV2Pair {
    function mint(address) external returns (uint256);
}

contract BlacklistToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blacklisted;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint256 supply, address owner) {
        name = name_;
        symbol = symbol_;
        totalSupply = supply;
        balanceOf[owner] = supply;
        emit Transfer(address(0), owner, supply);
    }

    function setBlacklist(address addr, bool status) external {
        blacklisted[addr] = status;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(!blacklisted[from], "BLACKLISTED_SENDER");
        require(!blacklisted[to], "BLACKLISTED_RECIPIENT");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}

interface IHookReceiver {
    function tokensReceived(address from, address to, uint256 amount) external;
}

contract HookReentrantReceiver {
    address public pump;
    address public targetToken;
    bool public reentryAttempted;
    bool public pumpReentryBlocked;

    constructor(address pump_) {
        pump = pump_;
    }

    function setTargetToken(address token) external {
        targetToken = token;
    }

    function tokensReceived(address, address, uint256) external {
        reentryAttempted = true;
        (bool ok, ) = pump.call{value: 0}(
            abi.encodeWithSignature("buy(address,uint256)", targetToken, 0)
        );
        pumpReentryBlocked = !ok;
    }

    receive() external payable {}
}

contract PostTransferHookToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint256 supply, address owner) {
        name = name_;
        symbol = symbol_;
        totalSupply = supply;
        balanceOf[owner] = supply;
        emit Transfer(address(0), owner, supply);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        // Post-transfer hook: if recipient is a registered hook receiver, call it
        uint32 size;
        assembly { size := extcodesize(to) }
        if (size > 0) {
            IHookReceiver(to).tokensReceived(from, to, amount);
        }
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}

contract GasGriefer {
    uint256 public gasWasted;
    uint256 public constant LOOP_COUNT = 5000;

    receive() external payable {
        uint256 start = gasleft();
        for (uint256 i = 0; i < LOOP_COUNT; i++) {
            gasWasted = i;
        }
        uint256 used = start - gasleft();
        gasWasted = used;
    }

    function buy(address pumpAddr, address token) external payable {
        (bool ok, ) = pumpAddr.call{value: msg.value}(
            abi.encodeWithSignature("buy(address,uint256)", token, 0)
        );
        require(ok, "PUMP_BUY_FAILED");
    }
}

contract FeeOnTransferToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    uint256 public constant feeBps = 500; // 5% fee

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint256 supply, address owner) {
        name = name_;
        symbol = symbol_;
        totalSupply = supply;
        balanceOf[owner] = supply;
        emit Transfer(address(0), owner, supply);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        uint256 fee = amount * feeBps / 10000;
        uint256 net = amount - fee;
        balanceOf[from] -= amount;
        balanceOf[to] += net;
        balanceOf[address(0)] += fee; // burn fee
        emit Transfer(from, to, net);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}
