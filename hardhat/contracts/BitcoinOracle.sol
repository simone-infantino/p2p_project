// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract BitcoinOracle {
    address public owner;                   //deployer account
    address public new_owner;               //new owner after transfer operation is complete
    uint256 public minimum_fee;             //calculated at deployment time
    bool    public terminated;
    uint256 public immutable deployed_block;//needed by the oracle_daemon to resume operations


    mapping(string => uint256) public balances; //the mapping uses a "string" value because we are treating the bitcoin address as a string

    event update_requested(string BTC_addr, address indexed requester, uint256 fee);
    event balance_updated(string BTC_addr, uint256 satoshis);
    event minimum_fee_updated(uint256 new_fee);
    event oracle_terminated();
    event owner_transfer_start(address indexed current_owner, address indexed new_owner);
    event owner_transfer_complete(address indexed previousOwner, address indexed new_owner);

    modifier only_owner() { require(msg.sender == owner, "not oracle"); _; }
    modifier not_terminated() { require(!terminated, "terminated"); _; }

    constructor(uint256 _minimum_fee) {
        owner = msg.sender;
        minimum_fee = _minimum_fee;
        deployed_block = block.number;
    }

    //for applicants. optionally used before requesting a loan to update a certain bitcoin address balance
    function request_update(string calldata BTC_addr) external payable not_terminated{
        require(msg.value >= minimum_fee, "fee too low");
        emit update_requested(BTC_addr, msg.sender, msg.value);
    }

    //used by the oracle itself
    function push_balance(string calldata BTC_addr, uint256 satoshis) external only_owner not_terminated{
        balances[BTC_addr] = satoshis;
        emit balance_updated(BTC_addr, satoshis);
    }


    function get_balance(string calldata BTC_addr) external view returns (uint256) {
        return balances[BTC_addr];
    }

    //the initial value of minimum fee is set with the constructor after calling a faux push_balance 
    function set_minimum_fee(uint256 _fee) external only_owner {
        minimum_fee = _fee;
        emit minimum_fee_updated(_fee);
    }

    //normally we would send the fees to the owner by using msg.sender as a recipient of the .call function but seeing as this is not specified in
    //the project requirements we're letting the owner decide who to send the value to
    function withdraw_fees(address payable recipient) external only_owner {
        require(recipient != address(0), "zero address");
        uint256 bal = address(this).balance;
        (bool ok, ) = recipient.call{value: bal}("");
        require(ok, "fee withdrawal failed");
    }

    function terminate() external only_owner { 
        terminated = true;
        emit oracle_terminated(); 
    }

    //2-step, symmetric transfer procedure to avoid mistakes and locking the contract in an unrecoverable state
    function transfer_ownership(address transfer_to) external only_owner {
        require(transfer_to != address(0), "zero address");
        new_owner = transfer_to;
        emit owner_transfer_start(owner, transfer_to);
    }

    function accept_ownership() external {
        require(msg.sender == new_owner, "not pending owner");
        address previous = owner;
        owner = new_owner;
        new_owner = address(0); //just to be safe
        emit owner_transfer_complete(previous, owner);
    }
}
