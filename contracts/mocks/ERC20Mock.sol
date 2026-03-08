// SPDX-License-Identifier: MIT

pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// https://github.com/OpenZeppelin/openzeppelin-contracts/blob/0a25c1940ca220686588c4af3ec526f725fe2582/contracts/mocks/ERC20Mock.sol
// mock class using ERC20
contract ERC20Mock is ERC20 {
    uint8 private _customDecimals;

    constructor(
        string memory name,
        string memory symbol,
        address initialAccount,
        uint256 initialBalance,
        uint8 decimals_
    ) payable ERC20(name, symbol) {
        _customDecimals = decimals_;
        _mint(initialAccount, initialBalance);
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    function mint(address account, uint256 amount) public {
        _mint(account, amount);
    }

    function burn(address account, uint256 amount) public {
        _burn(account, amount);
    }

    function transferInternal(
        address from,
        address to,
        uint256 value
    ) public {
        _transfer(from, to, value);
    }

    function approveInternal(
        address owner,
        address spender,
        uint256 value
    ) public {
        _approve(owner, spender, value);
    }
}
