// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title DuoSwapStaking
 * @dev Single pool staking contract for DuoSwap ecosystem.
 * Refactored for maximum security using OpenZeppelin standards.
 * This contract does NOT support Fee-on-Transfer (FoT) tokens.
 */
contract DuoSwapStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct UserInfo {
        uint256 amount;
        uint256 rewardDebt;
    }

    IERC20 public immutable lpToken;
    IERC20 public immutable rewardToken;

    uint256 public rewardPerBlock;
    uint256 public rewardEndBlock;
    uint256 public lastRewardBlock;
    uint256 public accRewardPerShare; // scaled by 1e12
    uint256 public totalStaked;
    bool public rewardsStarted;

    mapping(address => UserInfo) public userInfo;

    event Deposit(address indexed user, uint256 amount);
    event Withdraw(address indexed user, uint256 amount);
    event Claim(address indexed user, uint256 amount);
    event EmergencyWithdraw(address indexed user, uint256 amount);
    event RewardsStarted(
        uint256 rewardPerBlock,
        uint256 startBlock,
        uint256 endBlock,
        uint256 totalReward
    );
    event RewardsAdded(
        uint256 addedReward,
        uint256 rewardPerBlock,
        uint256 startBlock,
        uint256 endBlock,
        uint256 totalReward
    );

    constructor(
        address lpToken_,
        address rewardToken_,
        address owner_
    ) Ownable(owner_) {
        require(lpToken_ != address(0), "STAKING: ZERO_LP");
        require(rewardToken_ != address(0), "STAKING: ZERO_REWARD");

        lpToken = IERC20(lpToken_);
        rewardToken = IERC20(rewardToken_);
    }

    /**
     * @dev Starts the reward emission.
     * Rewards are funded by the current DUO balance held by this contract.
     */
    function startRewards(uint256 rewardBlocks) external onlyOwner {
        require(!rewardsStarted, "STAKING: STARTED");
        require(rewardBlocks > 0, "STAKING: ZERO_BLOCKS");

        uint256 rewardBalance = rewardToken.balanceOf(address(this));
        require(rewardBalance > 0, "STAKING: NO_REWARD_BALANCE");

        uint256 perBlock = rewardBalance / rewardBlocks;
        require(perBlock > 0, "STAKING: TOO_FEW_REWARDS");

        rewardsStarted = true;
        rewardPerBlock = perBlock;
        lastRewardBlock = block.number;
        rewardEndBlock = block.number + rewardBlocks;

        emit RewardsStarted(
            perBlock,
            block.number,
            rewardEndBlock,
            rewardBalance
        );
    }

    /**
     * @dev Funds this staking pool and starts the reward emission in a single tx.
     * In this single-pool contract, pool parameters are fixed at deployment time.
     */
    function fundAndStartRewards(
        uint256 amount,
        uint256 rewardBlocks
    ) external onlyOwner nonReentrant {
        require(!rewardsStarted, "STAKING: STARTED");
        _addRewards(amount, rewardBlocks, true);
    }

    /**
     * @dev Adds reward tokens to an existing pool and recalculates the reward schedule
     * using the undistributed rewards plus the newly funded amount.
     */
    function addRewards(
        uint256 amount,
        uint256 rewardBlocks
    ) external onlyOwner nonReentrant {
        require(rewardsStarted, "STAKING: NOT_STARTED");
        _addRewards(amount, rewardBlocks, false);
    }

    /**
     * @dev Backward-compatible wrapper. Kept to avoid breaking existing integrations.
     */
    function addRewardsForNewPool(
        uint256 amount,
        uint256 rewardBlocks
    ) external onlyOwner nonReentrant {
        require(!rewardsStarted, "STAKING: STARTED");
        _addRewards(amount, rewardBlocks, true);
    }

    /**
     * @dev Backward-compatible wrapper. Kept to avoid breaking existing integrations.
     */
    function addRewardsForExistingPool(
        uint256 amount,
        uint256 rewardBlocks
    ) external onlyOwner nonReentrant {
        require(rewardsStarted, "STAKING: NOT_STARTED");
        _addRewards(amount, rewardBlocks, false);
    }

    function pendingReward(address user) external view returns (uint256) {
        UserInfo memory u = userInfo[user];
        uint256 _accRewardPerShare = accRewardPerShare;

        if (
            rewardsStarted && block.number > lastRewardBlock && totalStaked > 0
        ) {
            uint256 toBlock = _lastRewardBlockApplicable();
            if (toBlock > lastRewardBlock) {
                uint256 blocks = toBlock - lastRewardBlock;
                uint256 reward = blocks * rewardPerBlock;
                _accRewardPerShare += (reward * 1e12) / totalStaked;
            }
        }
        return ((u.amount * _accRewardPerShare) / 1e12) - u.rewardDebt;
    }

    function deposit(uint256 amount) external nonReentrant {
        UserInfo storage u = userInfo[msg.sender];
        _updatePool();

        uint256 accumulated = (u.amount * accRewardPerShare) / 1e12;
        uint256 pending = accumulated - u.rewardDebt;

        // ---------- Handle LP first ----------
        if (amount > 0) {
            uint256 balanceBefore = lpToken.balanceOf(address(this));
            lpToken.safeTransferFrom(msg.sender, address(this), amount);
            uint256 balanceAfter = lpToken.balanceOf(address(this));
            uint256 receivedAmount = balanceAfter - balanceBefore;
            require(receivedAmount == amount, "STAKING: FOT_NOT_SUPPORTED");

            u.amount += amount;
            totalStaked += amount;
            emit Deposit(msg.sender, amount);
        }

        // ---------- Update debt first (critical) ----------
        uint256 newAccumulated = (u.amount * accRewardPerShare) / 1e12;
        u.rewardDebt = newAccumulated;

        // ---------- Then send rewards ----------
        if (pending > 0) {
            uint256 sent = _safeRewardTransfer(msg.sender, pending);

            // ✅ Rollback unsent portion
            if (sent < pending) {
                u.rewardDebt -= (pending - sent);
            }

            emit Claim(msg.sender, sent);
        }
    }

    function withdraw(uint256 amount) external nonReentrant {
    UserInfo storage u = userInfo[msg.sender];
    require(u.amount >= amount, "STAKING: AMOUNT_TOO_HIGH");

    _updatePool();

    uint256 accumulated = (u.amount * accRewardPerShare) / 1e12;
    uint256 pending = accumulated - u.rewardDebt;

        // ---------- Update state first ----------
    if (amount > 0) {
        u.amount -= amount;
        totalStaked -= amount;
    }

    uint256 newAccumulated = (u.amount * accRewardPerShare) / 1e12;
    u.rewardDebt = newAccumulated;

        // ---------- Send rewards ----------
    if (pending > 0) {
        uint256 sent = _safeRewardTransfer(msg.sender, pending);

        if (sent < pending) {
            u.rewardDebt -= (pending - sent);
        }

        emit Claim(msg.sender, sent);
    }

        // ---------- Then transfer LP ----------
    if (amount > 0) {
        lpToken.safeTransfer(msg.sender, amount);
        emit Withdraw(msg.sender, amount);
    }
}

    function claim() external nonReentrant {
    UserInfo storage u = userInfo[msg.sender];
    _updatePool();

    uint256 accumulated = (u.amount * accRewardPerShare) / 1e12;
    uint256 pending = accumulated - u.rewardDebt;

        // ---------- Update debt first ----------
    u.rewardDebt = accumulated;

        // ---------- Then send rewards ----------
    if (pending > 0) {
        uint256 sent = _safeRewardTransfer(msg.sender, pending);

        if (sent < pending) {
            u.rewardDebt -= (pending - sent);
        }

        emit Claim(msg.sender, sent);
    }
}
    function emergencyWithdraw() external nonReentrant {
        UserInfo storage u = userInfo[msg.sender];
        uint256 amount = u.amount;
        require(amount > 0, "STAKING: NO_STAKE");

        u.amount = 0;
        u.rewardDebt = 0;
        totalStaked -= amount;

        lpToken.safeTransfer(msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, amount);
    }

    /**
     * @dev Allows owner to recover leftover rewards after the emission period ends.
     */
    function recoverEndedRewards(
        address to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        require(to != address(0), "STAKING: ZERO_TO");
        require(
            rewardsStarted && block.number > rewardEndBlock,
            "STAKING: NOT_ENDED"
        );
        rewardToken.safeTransfer(to, amount);
    }

    function _updatePool() internal {
        if (!rewardsStarted) {
            return;
        }
        if (block.number <= lastRewardBlock) {
            return;
        }
        if (totalStaked == 0) {
            lastRewardBlock = _lastRewardBlockApplicable();
            return;
        }

        uint256 toBlock = _lastRewardBlockApplicable();
        if (toBlock <= lastRewardBlock) {
            return;
        }

        uint256 blocks = toBlock - lastRewardBlock;
        uint256 reward = blocks * rewardPerBlock;
        accRewardPerShare += (reward * 1e12) / totalStaked;
        lastRewardBlock = toBlock;
    }

    function _lastRewardBlockApplicable() internal view returns (uint256) {
        return block.number < rewardEndBlock ? block.number : rewardEndBlock;
    }

    function _safeRewardTransfer(
        address to,
        uint256 amount
    ) internal returns (uint256) {
        uint256 bal = rewardToken.balanceOf(address(this));
        uint256 sendAmount = amount > bal ? bal : amount;

        if (sendAmount > 0) {
            rewardToken.safeTransfer(to, sendAmount);
        }

        return sendAmount; // ✅ Return actual amount sent
    }

    function _addRewards(
        uint256 amount,
        uint256 rewardBlocks,
        bool isNewPool
    ) internal {
        require(amount > 0, "STAKING: ZERO_REWARD_AMOUNT");
        require(rewardBlocks > 0, "STAKING: ZERO_BLOCKS");

        _updatePool();

        uint256 balanceBefore = rewardToken.balanceOf(address(this));
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 fundedAmount = rewardToken.balanceOf(address(this)) -
            balanceBefore;
        require(fundedAmount == amount, "STAKING: FOT_NOT_SUPPORTED");

        uint256 remainingRewards;
        if (rewardsStarted && rewardEndBlock > lastRewardBlock) {
            remainingRewards =
                (rewardEndBlock - lastRewardBlock) *
                rewardPerBlock;
        }

        uint256 totalReward = isNewPool
            ? rewardToken.balanceOf(address(this))
            : remainingRewards + fundedAmount;
        uint256 perBlock = totalReward / rewardBlocks;
        require(perBlock > 0, "STAKING: TOO_FEW_REWARDS");

        rewardsStarted = true;
        rewardPerBlock = perBlock;
        lastRewardBlock = block.number;
        rewardEndBlock = block.number + rewardBlocks;

        if (isNewPool) {
            emit RewardsStarted(
                perBlock,
                block.number,
                rewardEndBlock,
                totalReward
            );
        } else {
            emit RewardsAdded(
                fundedAmount,
                perBlock,
                block.number,
                rewardEndBlock,
                totalReward
            );
        }
    }
}
