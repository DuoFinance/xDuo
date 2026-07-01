// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./DuoBondingCurve.sol";

contract DuoBondingCurveFactory {
    struct CurveInfo {
        address token;
        string name;
        string symbol;
        uint256 gradient;
        uint256 targetReserve;
        address creator;
        uint256 createdAt;
    }

    CurveInfo[] private _curves;
    mapping(address => uint256) private _curveIndexPlusOne;
    mapping(address => address[]) private _creatorCurves;

    event CurveDeployed(
        address indexed creator,
        address indexed token,
        string symbol,
        uint256 gradient,
        uint256 targetReserve
    );

    function deployCurve(
        string calldata name_,
        string calldata symbol_,
        uint256 gradient_,
        uint256 targetReserve_,
        address router_,
        address factory_
    ) external returns (address token) {
        require(bytes(name_).length > 0, "NAME_EMPTY");
        require(bytes(symbol_).length > 0, "SYMBOL_EMPTY");
        require(gradient_ > 0, "GRADIENT_ZERO");
        require(targetReserve_ > 0, "TARGET_ZERO");

        DuoBondingCurve curve = new DuoBondingCurve(
            name_,
            symbol_,
            gradient_,
            targetReserve_,
            router_,
            factory_
        );
        token = address(curve);

        _curves.push(
            CurveInfo({
                token: token,
                name: name_,
                symbol: symbol_,
                gradient: gradient_,
                targetReserve: targetReserve_,
                creator: msg.sender,
                createdAt: block.timestamp
            })
        );
        _curveIndexPlusOne[token] = _curves.length;
        _creatorCurves[msg.sender].push(token);

        emit CurveDeployed(msg.sender, token, symbol_, gradient_, targetReserve_);
    }

    // --- Query functions (matching DuoTokenDeployer API) ---

    function getCurveCount() external view returns (uint256) {
        return _curves.length;
    }

    function getCurveAt(uint256 index) external view returns (CurveInfo memory) {
        require(index < _curves.length, "INDEX_OOB");
        return _curves[index];
    }

    function getCurveInfo(address token) external view returns (CurveInfo memory) {
        uint256 idx = _curveIndexPlusOne[token];
        require(idx > 0, "NOT_FOUND");
        return _curves[idx - 1];
    }

    function getAllCurves() external view returns (CurveInfo[] memory) {
        return _curves;
    }

    function getCreatorCurves(address creator) external view returns (address[] memory) {
        return _creatorCurves[creator];
    }

    function exists(address token) external view returns (bool) {
        return _curveIndexPlusOne[token] > 0;
    }
}
