// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract BitcoinOracle {
    address public owner;             // off-chain oracle service account
    uint256 public minimumFee;        // = gasCost(pushBalance) * 0.1 gwei (set via measurement)
    uint256 public immutable deploymentBlock; // helps the off-chain daemon resume from here

    // BTC address keyed by the ASCII bytes of its canonical string form
    // (exactly what bitcoinj's address.toString() / python-bitcoinlib str(addr) produces).
    mapping(bytes => uint256) public balances; // satoshis
    mapping(bytes => bool)    public tracked;

    // NOTE: btcAddr is intentionally NOT indexed. Indexed dynamic types are stored
    // as a keccak hash in the log topic, which the off-chain service could never
    // decode back into the actual address. Keep it in the data section.
    event UpdateRequested(bytes btcAddr, address indexed requester, uint256 fee);
    event BalanceUpdated(bytes btcAddr, uint256 satoshis);
    event MinimumFeeUpdated(uint256 newFee);

    modifier onlyOwner() { require(msg.sender == owner, "not oracle"); _; }

    constructor(uint256 _minimumFee) {
        owner = msg.sender;
        minimumFee = _minimumFee;
        deploymentBlock = block.number;
    }

    /// Applicants call this to enqueue a refresh of `btcAddr`.
    function requestUpdate(bytes calldata btcAddr) external payable {
        require(msg.value >= minimumFee, "fee too low");
        tracked[btcAddr] = true;
        emit UpdateRequested(btcAddr, msg.sender, msg.value);
    }

    /// Called by the off-chain oracle after scanning UTXOs. This is the
    /// "update operation" whose gas cost defines the minimum fee.
    function pushBalance(bytes calldata btcAddr, uint256 satoshis) external onlyOwner {
        balances[btcAddr] = satoshis;
        tracked[btcAddr] = true;
        emit BalanceUpdated(btcAddr, satoshis);
    }

    function getBalance(bytes calldata btcAddr) external view returns (uint256) {
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
}
