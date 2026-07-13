// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TokenTemplate - pump.fun style ERC20 token on NeoX
/// @notice Deployed by the Pump main contract, fixed supply of 1B, non-upgradeable, non-mintable
/// @dev Mirrors pump.fun's token program, standard ERC20 + Ownable
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract PumpToken is ERC20, Ownable {
    uint8 private immutable _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 totalSupply_,
        address owner_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        _decimals = decimals_;
        // Mint all supply to Pump main contract for distribution to buyers
        _mint(owner_, totalSupply_);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
