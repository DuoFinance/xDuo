// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IUniswapV2 - Minimal interfaces for duoLaunch graduation
interface IUniswapV2Factory {
    function createPair(address tokenA, address tokenB) external returns (address pair);
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function feeTo() external view returns (address);
}

interface IUniswapV2Pair {
    function mint(address to) external returns (uint256 liquidity);
    function totalSupply() external view returns (uint256);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

interface IWETH {
    function deposit() external payable;
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}
