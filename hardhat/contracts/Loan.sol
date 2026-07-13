// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface Loan_Service_Interface {
    function loan_refund(address contributor, uint256 repaid_base_amount) external payable;
    function loan_collateral() external payable;
    function loan_success() external;
}

//total owed = lent_amount * (100 + interest_rate) / 100
contract Loan {
    Loan_Service_Interface public immutable service;
    address public immutable applicant;
    uint256 public immutable lent_amount;       //actual lent amount (after rounding errors)
    uint8   public immutable interest_rate;
    uint256 public immutable duration;          //in blocks
    uint256 public immutable loan_start_block;
    uint8   public immutable collateral_percent;

    //contributors sorted by initial locked descending order, address ascending order
    address[] public contributors;
    mapping(address => uint256) public initial_locked;
    mapping(address => uint256) public remaining_due;

    uint256 public total_base_repaid;
    bool    public successful;
    bool    public failed_marked;

    event repaid(address indexed applicant, uint256 repaid_base_amount, uint256 interestAmount);
    event contributor_refunded(address indexed contributor, uint256 amount);
    event paid_interest(address indexed contributor, uint256 amount);
    event loan_successful();
    event loan_failed_marked();

    constructor(
        address _applicant,
        uint256 _lent_amount,
        uint8 _interest_rate,
        uint256 _duration,
        uint8 _collateral_percent,
        address[] memory _sorted_contributors,
        uint256[] memory _locked_amounts
    ) payable {
        require(msg.value == _lent_amount, "loan amount mismatch mismatch");
        require(_sorted_contributors.length == _locked_amounts.length, "bad inputs");
        service = Loan_Service_Interface(msg.sender);
        applicant = _applicant;
        lent_amount = _lent_amount;
        interest_rate = _interest_rate;
        duration = _duration;
        loan_start_block = block.number;
        collateral_percent = _collateral_percent;

        for (uint256 i = 0; i < _sorted_contributors.length; ++i) {
            address c = _sorted_contributors[i];
            contributors.push(c);
            initial_locked[c] = _locked_amounts[i];
            remaining_due[c]  = _locked_amounts[i];
        }

        //forward value to applicant
        (bool ok, ) = _applicant.call{value: _lent_amount}("");
        require(ok, "applicant transfer failed");
    }

    function expiration_block() public view returns (uint256) { return loan_start_block + duration; }
    function is_expired() public view returns (bool) { return block.number > expiration_block(); }
    function is_failed() public view returns (bool) { return is_expired() && total_base_repaid < lent_amount; }

    //payment is split into base and interest (proportionally). Interest is again split in actual interest and collateral
    function repay() external payable {
        require(msg.sender == applicant, "only applicant");
        require(!successful, "already closed");

        uint256 payment = msg.value;
        uint256 base = (payment * 100) / (100 + uint256(interest_rate));
        uint256 interest = payment - base;

        uint256 due_total_left = lent_amount > total_base_repaid ? lent_amount - total_base_repaid : 0;
        if (base > due_total_left) {
            uint256 excess = base - due_total_left;
            base = due_total_left;
            if (excess > 0) service.loan_collateral{value: excess}();
        }

        if (base > 0) distribute_base(base);
        if (interest > 0) distribute_interest(interest);

        emit repaid(applicant, base, interest);

        //a failed loan may still be repaid, but it can never become successful.
        if (!failed_marked && total_base_repaid >= lent_amount) {
            successful = true;
            service.loan_success();
            emit loan_successful();
        }
    }

    function distribute_base(uint256 amount) internal {
        total_base_repaid += amount;
        uint256 n = contributors.length;
        //refund contributors in order, highest initial locked first
        for (uint256 i = 0; i < n && amount > 0; ++i) {
            address c = contributors[i];
            uint256 due = remaining_due[c];
            if (due == 0) continue;
            uint256 base_repayment = amount > due ? due : amount;
            remaining_due[c] = due - base_repayment;
            amount -= base_repayment;
            service.loan_refund{value: base_repayment}(c, base_repayment);
            emit contributor_refunded(c, base_repayment);
        }
        //leftover base beyond what contributors are still owed goes to the compensation pool. This could
        //happen when a contributor calls for compensation (forfeiting its share of this repayment) and then the loan receives a repayment
        if (amount > 0) {
            service.loan_collateral{value: amount}();
        }
    }

    function distribute_interest(uint256 interest) internal {
        uint256 collateral = (interest * collateral_percent) / 100;
        uint256 gain = interest - collateral;

        //collateral to compensation pool
        if (collateral > 0) service.loan_collateral{value: collateral}();

        //interests are paid to contributors
        uint256 distributed = 0;
        uint256 n = contributors.length;
        for (uint256 i = 0; i < n; ++i) {
            address c = contributors[i];
            uint256 share = (gain * initial_locked[c]) / lent_amount;
            if (share > 0) {
                distributed += share;
                (bool ok, ) = c.call{value: share}("");
                require(ok, "gain transfer failed");
                emit paid_interest(c, share);
            }
        }
        //leftover value created by integer rounding is sent to the compensation pool
        uint256 leftover = gain - distributed;
        if (leftover > 0) service.loan_collateral{value: leftover}();
    }

    //called by LendingService on the first compensation claim against a failed loan.
    function mark_failed() external {
        require(msg.sender == address(service), "only service");
        require(!failed_marked, "already marked");
        require(is_failed(), "not failed");
        failed_marked = true;
        emit loan_failed_marked();
    }

    //called by LendingService when a contributor claims compensation. reduces their
    //remaining_due so later repayments skip the already-compensated portion.
    function apply_compensation(address contributor, uint256 amount) external {
        require(msg.sender == address(service), "only service");
        uint256 due = remaining_due[contributor];
        uint256 portion = amount > due ? due : amount;
        remaining_due[contributor] = due - portion;
    }
}
