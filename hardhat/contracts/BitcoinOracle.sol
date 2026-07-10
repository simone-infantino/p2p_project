// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract BitcoinOracle {
    address public owner;           //deployer account
    address public new_owner;    //new owner after transfer operation is complete
    uint256 public minimumFee;      //calculated at deployment time
    uint256 public immutable deployed_block; //needed by the oracle_daemon to resume operations

    mapping(string => uint256) public balances; //the mapping uses a "string" value because the .toString used in the offchain scanner 

    event UpdateRequested(string btcAddr, address indexed requester, uint256 fee);
    event BalanceUpdated(string btcAddr, uint256 satoshis);
    event MinimumFeeUpdated(uint256 newFee);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed new_owner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() { require(msg.sender == owner, "not oracle"); _; }

    constructor(uint256 _minimumFee) {
        owner = msg.sender;
        minimumFee = _minimumFee;
        deployed_block = block.number;
    }

    /// Applicants call this to enqueue a refresh of `btcAddr`.
    function requestUpdate(string calldata btcAddr) external payable {
        require(msg.value >= minimumFee, "fee too low");
        emit UpdateRequested(btcAddr, msg.sender, msg.value);
    }

    /// Called by the off-chain oracle after scanning UTXOs. This is the
    /// "update operation" whose gas cost defines the minimum fee.
    function pushBalance(string calldata btcAddr, uint256 satoshis) external onlyOwner {
        balances[btcAddr] = satoshis;
        emit BalanceUpdated(btcAddr, satoshis);
    }

    function getBalance(string calldata btcAddr) external view returns (uint256) {
        return balances[btcAddr];
    }

    /// Set the minimum fee after measuring the gas cost of pushBalance.
    /// minimumFee should equal gasCost(pushBalance) * 0.1 gwei (see measure_oracle_fee.ts).
    function setMinimumFee(uint256 _fee) external onlyOwner {
        minimumFee = _fee;
        emit MinimumFeeUpdated(_fee);
    }

    function withdrawFees(address payable to) external onlyOwner {
        uint256 bal = address(this).balance;
        (bool ok, ) = to.call{value: bal}("");
        require(ok, "fee withdrawal failed");
    }

/// Step 1: the current owner nominates a new owner. Nothing changes yet —
/// the nominee must accept, which prevents handing ownership to a wrong/dead address.
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        new_owner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

/// Step 2: the nominee accepts, completing the transfer. Only the pending owner
/// can call this, proving they control the new key.
    function acceptOwnership() external {
        require(msg.sender == new_owner, "not pending owner");
        address previous = owner;
        owner = new_owner;
        new_owner = address(0);
        emit OwnershipTransferred(previous, owner);
    }
}
