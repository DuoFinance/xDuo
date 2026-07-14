// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./DuoSwapStaking.sol";

/**
 * @title DuoSwapStakingFactory
 * @dev Deploys single-pool staking contracts and can optionally fund/start rewards at creation time.
 * Does not support Fee-on-Transfer (FoT) reward tokens.
 * Github repo : https://github.com/DuoFinance/xDuo.git
**/
contract DuoSwapStakingFactory is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    event PoolCreated(
        address indexed staking,
        address indexed lpToken,
        address indexed rewardToken,
        address stakingOwner,
        uint256 rewardAmount,
        uint256 rewardBlocks
    );

    constructor(address owner_) Ownable(owner_) {}

    function createPool(address lpToken, address rewardToken, address stakingOwner) external onlyOwner returns (address) {
        require(stakingOwner != address(0), "FACTORY: ZERO_OWNER");

        DuoSwapStaking staking = new DuoSwapStaking(lpToken, rewardToken, stakingOwner);
        address stakingAddress = address(staking);

        emit PoolCreated(stakingAddress, lpToken, rewardToken, stakingOwner, 0, 0);
        return stakingAddress;
    }

    function createPoolWithRewards(
        address lpToken,
        address rewardToken,
        address stakingOwner,
        uint256 rewardAmount,
        uint256 rewardBlocks
    ) external onlyOwner nonReentrant returns (address) {
        require(stakingOwner != address(0), "FACTORY: ZERO_OWNER");
        require(rewardAmount > 0, "FACTORY: ZERO_REWARD_AMOUNT");
        require(rewardBlocks > 0, "FACTORY: ZERO_BLOCKS");

        DuoSwapStaking staking = new DuoSwapStaking(lpToken, rewardToken, address(this));
        address stakingAddress = address(staking);

        IERC20 rewardTokenContract = IERC20(rewardToken);
        uint256 balanceBefore = rewardTokenContract.balanceOf(address(this));
        rewardTokenContract.safeTransferFrom(msg.sender, address(this), rewardAmount);
        uint256 fundedAmount = rewardTokenContract.balanceOf(address(this)) - balanceBefore;
        require(fundedAmount == rewardAmount, "FACTORY: FOT_NOT_SUPPORTED");
        rewardTokenContract.forceApprove(stakingAddress, rewardAmount);

        staking.fundAndStartRewards(rewardAmount, rewardBlocks);
        staking.transferOwnership(stakingOwner);
        rewardTokenContract.forceApprove(stakingAddress, 0);

        emit PoolCreated(stakingAddress, lpToken, rewardToken, stakingOwner, rewardAmount, rewardBlocks);
        return stakingAddress;
    }
}
