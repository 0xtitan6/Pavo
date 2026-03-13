// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MockSanctionsList - Mock Chainalysis sanctions oracle for testing
contract MockSanctionsList {
    mapping(address => bool) public isSanctioned;

    function setSanctioned(address addr, bool sanctioned) external {
        isSanctioned[addr] = sanctioned;
    }
}
