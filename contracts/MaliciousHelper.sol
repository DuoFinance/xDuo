// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MaliciousHelper - attack contracts for Pump robustness testing
contract RefundGriefer {
    bool public rejectEther;
    event CalledBack();

    constructor() { rejectEther = true; }

    function setReject(bool val) external { rejectEther = val; }

    receive() external payable {
        if (rejectEther) revert("REFUND_REJECTED");
    }

    /// Buy with overpay to trigger refund path, then revert on refund
    function attackRefundGrief(address pump, address token) external payable {
        (bool ok, ) = pump.call{value: msg.value}(abi.encodeWithSignature("buy(address,uint256)", token, 0));
        require(ok, "BUY_FAILED");
    }
}

/// Contract that tries to re-enter Pump via receive during refund
contract ReentrancyAttacker {
    address public pump;
    address public token;
    bool public entered;
    bool public reentrancySucceeded;

    constructor(address pump_, address token_) {
        pump = pump_;
        token = token_;
    }

    receive() external payable {
        if (!entered) {
            entered = true;
            // Try to re-enter buy
            (bool ok, ) = pump.call{value: 0}(abi.encodeWithSignature("buy(address,uint256)", token, 0));
            if (ok) reentrancySucceeded = true;

            // Try to re-enter sell
            (ok, ) = pump.call(abi.encodeWithSignature("sell(address,uint256,uint256)", token, 0, 0));
            if (ok) reentrancySucceeded = true;
        }
    }

    function attack(address pump_, address token_) external payable {
        pump = pump_;
        token = token_;
        (bool ok, ) = pump.call{value: msg.value}(abi.encodeWithSignature("buy(address,uint256)", token, 0));
        require(ok, "BUY_FAILED");
    }
}
