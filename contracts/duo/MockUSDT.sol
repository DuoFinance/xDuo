// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDT
 * @dev Test-only USDT mock: fixed supply of 1M, 4 decimals.
 * Mints the full supply to the deployer on construction.
 */
contract MockUSDT is ERC20 {
    uint256 public constant MOCK_SUPPLY = 1_000_000 * 1e4;

    constructor() ERC20("Tether USD (Test)", "USDT") {
        _mint(msg.sender, MOCK_SUPPLY);
    }

    function decimals() public pure override returns (uint8) {
        return 4;
    }
}
