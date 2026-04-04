// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract EvmMemeToken {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 totalSupply_,
        address owner_
    ) {
        require(bytes(name_).length > 0, "TOKEN_NAME_EMPTY");
        require(bytes(symbol_).length > 0, "TOKEN_SYMBOL_EMPTY");
        require(owner_ != address(0), "TOKEN_OWNER_ZERO");

        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        totalSupply = totalSupply_;

        balanceOf[owner_] = totalSupply_;
        emit Transfer(address(0), owner_, totalSupply_);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (from != msg.sender && allowed != type(uint256).max) {
            require(allowed >= value, "TOKEN_ALLOWANCE_LOW");
            unchecked {
                allowance[from][msg.sender] = allowed - value;
            }
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "TOKEN_TO_ZERO");
        uint256 fromBalance = balanceOf[from];
        require(fromBalance >= value, "TOKEN_BALANCE_LOW");
        unchecked {
            balanceOf[from] = fromBalance - value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

contract EvmTokenDeployer {
    struct TokenInfo {
        address token;
        string name;
        string symbol;
        uint8 decimals;
        uint256 totalSupply;
        string author;
        string description;
        address creator;
        uint256 createdAt;
    }

    TokenInfo[] private _tokens;
    mapping(address => uint256) private _tokenIndexPlusOne;
    mapping(address => address[]) private _creatorTokens;

    event TokenDeployed(
        address indexed creator,
        address indexed token,
        string symbol,
        uint256 totalSupply,
        uint8 decimals,
        string author,
        string description
    );

    function deployToken(
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_,
        uint256 totalSupply_,
        string calldata author_,
        string calldata description_
    ) external returns (address token) {
        require(bytes(name_).length > 0, "DEPLOY_NAME_EMPTY");
        require(bytes(symbol_).length > 0, "DEPLOY_SYMBOL_EMPTY");
        require(decimals_ <= 18, "DEPLOY_DECIMALS_TOO_HIGH");
        require(totalSupply_ > 0, "DEPLOY_SUPPLY_ZERO");

        EvmMemeToken deployed = new EvmMemeToken(
            name_,
            symbol_,
            decimals_,
            totalSupply_,
            msg.sender
        );
        token = address(deployed);
        require(_tokenIndexPlusOne[token] == 0, "DEPLOY_DUP_TOKEN");

        _tokens.push(
            TokenInfo({
                token: token,
                name: name_,
                symbol: symbol_,
                decimals: decimals_,
                totalSupply: totalSupply_,
                author: author_,
                description: description_,
                creator: msg.sender,
                createdAt: block.timestamp
            })
        );
        _tokenIndexPlusOne[token] = _tokens.length;
        _creatorTokens[msg.sender].push(token);

        emit TokenDeployed(
            msg.sender,
            token,
            symbol_,
            totalSupply_,
            decimals_,
            author_,
            description_
        );
    }

    function getTokenCount() external view returns (uint256) {
        return _tokens.length;
    }

    function getTokenAt(uint256 index) external view returns (TokenInfo memory) {
        require(index < _tokens.length, "DEPLOY_INDEX_OOB");
        return _tokens[index];
    }

    function getTokenInfo(address token) external view returns (TokenInfo memory) {
        uint256 idx = _tokenIndexPlusOne[token];
        require(idx > 0, "DEPLOY_TOKEN_NOT_FOUND");
        return _tokens[idx - 1];
    }

    function getAllTokens() external view returns (TokenInfo[] memory) {
        return _tokens;
    }

    function getCreatorTokens(address creator) external view returns (address[] memory) {
        return _creatorTokens[creator];
    }

    function exists(address token) external view returns (bool) {
        return _tokenIndexPlusOne[token] > 0;
    }
}