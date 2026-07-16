// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TokenTemplate - ERC20 token on NeoX
/// @notice Deployed by the DuoLaunch contract, fixed supply of 1B, non-upgradeable, non-mintable
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TokenTemplate is ERC20 {
    uint8 private immutable _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 totalSupply_,
        address owner_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
        _mint(owner_, totalSupply_);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
