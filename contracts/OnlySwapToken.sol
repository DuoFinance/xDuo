// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title OnlySwapToken
 * @dev Custom ERC20 token for OnlySwap ecosystem with fixed supply and initial allocation split.
 * Refactored using OpenZeppelin standards for maximum security and compliance.
 */
contract OnlySwapToken is ERC20, Ownable {
    address public immutable treasury;
    bool public allocationInitialized;
    address public stakingContract;

    event AllocationInitialized(address indexed stakingContract, uint256 stakingAmount, uint256 treasuryAmount);

    constructor(
        uint256 totalSupply_,
        address treasury_,
        address owner_
    ) ERC20("OnlySwap", "OS") Ownable(owner_) {
        require(totalSupply_ > 0, "OS: ZERO_SUPPLY");
        require(treasury_ != address(0), "OS: ZERO_TREASURY");

        treasury = treasury_;
        
        // Mint all supply to the token contract itself initially.
        // This allows the owner to split it later via initializeAllocation.
        _mint(address(this), totalSupply_);
    }

    /**
     * @dev One-time split: 50% to a staking contract, 50% to the treasury.
     * Can only be called once by the owner.
     */
    function initializeAllocation(address stakingContract_) external onlyOwner {
        require(!allocationInitialized, "OS: ALREADY_INIT");
        require(stakingContract_ != address(0), "OS: ZERO_STAKING");

        allocationInitialized = true;
        stakingContract = stakingContract_;

        uint256 total = balanceOf(address(this));
        uint256 stakingAllocation = total * 50 / 100;
        uint256 treasuryAllocation = total - stakingAllocation;

        _transfer(address(this), stakingContract_, stakingAllocation);
        _transfer(address(this), treasury, treasuryAllocation);

        emit AllocationInitialized(stakingContract_, stakingAllocation, treasuryAllocation);
    }
}
