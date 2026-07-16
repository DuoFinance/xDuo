// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDuo - pump.fun style Fair Launch interface
/// @notice Uses x*y=k CP-AMM virtual pool, auto-creates Uniswap V2 pool on graduation
interface IDuo {
    /* ============ Events ============ */
    event SaleCreated(address indexed creator, address indexed token, string name, string symbol);
    event TokensPurchased(address indexed buyer, address indexed token, uint256 gasIn, uint256 tokensOut);
    event TokensSold(address indexed seller, address indexed token, uint256 tokensIn, uint256 gasOut);
    event SaleGraduated(address indexed token, address pair, uint256 tokensForLP, uint256 gasForLP);

    /* ============ Core Methods ============ */
    function createSale(string calldata name, string calldata symbol, uint256 graduationBps, uint256 targetRaise) external returns (address token);
    function createAndBuy(string calldata name, string calldata symbol, uint256 graduationBps, uint256 targetRaise, uint256 minTokensOut) external payable returns (address token, uint256 tokensOut);
    function buy(address token, uint256 minTokensOut) external payable returns (uint256 tokensOut);
    function sell(address token, uint256 tokensIn, uint256 minGasOut) external returns (uint256 gasOut);

    /* ============ Queries ============ */
    function getPair(address token) external view returns (address);

    function getSale(address token) external view returns (
        address creator,
        uint256 totalSupply,
        uint256 tokensSold,
        uint256 gasRaised,
        uint256 targetRaise,
        uint256 virtualGas,
        uint256 virtualToken,
        uint256 graduationBps,
        bool    graduated
    );
    function getCurrentPrice(address token) external view returns (uint256);
    function getTokensForGas(address token, uint256 gasAmount) external view returns (uint256);
    function getGasForTokens(address token, uint256 tokenAmount) external view returns (uint256);
}
