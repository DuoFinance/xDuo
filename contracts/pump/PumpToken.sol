// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PumpToken - pump.fun  ERC20 
/// @notice  Pump ， 1B，，
/// @dev  pump.fun  token ， ERC20 + Ownable
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
        //  mint  Pump ，
        _mint(owner_, totalSupply_);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
