// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract BitcoinOracle {
    address public owner;             // off-chain oracle service account
    uint256 public minimumFee;        // set at deployment based on measured gas
    
    // BTC address represented as bytes (20 bytes for P2PKH/P2SH; use bytes for bech32 too)
    mapping(bytes => uint256) public balances; // satoshis
    mapping(bytes => bool)    public tracked;
    
    event UpdateRequested(bytes indexed btcAddr, address indexed requester, uint256 fee);
    event BalanceUpdated(bytes indexed btcAddr, uint256 satoshis);
    
    modifier onlyOwner() { require(msg.sender == owner, "not oracle"); _; }
    
    constructor(uint256 _minimumFee) {
        owner = msg.sender;
        minimumFee = _minimumFee;
    }
    
    /// Applicants call this to enqueue a refresh of `btcAddr`.
    function requestUpdate(bytes calldata btcAddr) external payable {
        require(msg.value >= minimumFee, "fee too low");
        tracked[btcAddr] = true;
        emit UpdateRequested(btcAddr, msg.sender, msg.value);
    }
    
    /// Called by the off-chain oracle after scanning UTXOs.
    function pushBalance(bytes calldata btcAddr, uint256 satoshis) external onlyOwner {
        balances[btcAddr] = satoshis;
        tracked[btcAddr] = true;
        emit BalanceUpdated(btcAddr, satoshis);
    }
    
    function getBalance(bytes calldata btcAddr) external view returns (uint256) {
        return balances[btcAddr];
    }
    
    function withdrawFees(address payable to) external onlyOwner {
        to.transfer(address(this).balance);
    }
}