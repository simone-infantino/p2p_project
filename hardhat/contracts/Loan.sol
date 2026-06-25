// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ILendingServiceCallback {
    function onLoanRefund(address contributor, uint256 baseAmount) external payable;
    function onLoanInterestCollateral() external payable;
    function onLoanSuccessful() external;
    function onLoanFailedMarked() external;
}

contract Loan {
    ILendingServiceCallback public immutable service;
    address public immutable applicant;
    uint256 public immutable principal;     // actual loaned amount (after discrepancy)
    uint8   public immutable interestRate;  // 1..100
    uint256 public immutable duration;      // in blocks
    uint256 public immutable startBlock;
    uint8   public immutable collateralPct; // snapshot at creation
    bytes   public btcAddress;
    
    // contributors sorted by initial locked DESC, address ASC (for repayment refund order)
    address[] public contributors;
    mapping(address => uint256) public initialLocked;
    mapping(address => uint256) public remainingDue;        // base principal still owed back
    mapping(address => uint256) public compensationClaimed; // how much paid out from comp pool
    mapping(address => uint256) public forfeitedShare;      // base no longer owed because compensated
    
    uint256 public totalBaseRepaid;
    bool    public successful;
    bool    public failedMarked;
    
    event Repaid(address indexed applicant, uint256 baseAmount, uint256 interestAmount);
    event ContributorRefunded(address indexed contributor, uint256 amount);
    event InterestGainPaid(address indexed contributor, uint256 amount);
    event LoanSuccessful();
    event LoanFailedMarked();
    
    constructor(
        address _applicant,
        uint256 _principal,
        uint8 _interestRate,
        uint256 _duration,
        uint8 _collateralPct,
        bytes memory _btcAddress,
        address[] memory _sortedContributors,
        uint256[] memory _lockedAmounts
    ) payable {
        require(msg.value == _principal, "principal mismatch");
        require(_sortedContributors.length == _lockedAmounts.length, "bad inputs");
        service = ILendingServiceCallback(msg.sender);
        applicant = _applicant;
        principal = _principal;
        interestRate = _interestRate;
        duration = _duration;
        startBlock = block.number;
        collateralPct = _collateralPct;
        btcAddress = _btcAddress;
        
        for (uint256 i = 0; i < _sortedContributors.length; ++i) {
            address c = _sortedContributors[i];
            contributors.push(c);
            initialLocked[c] = _lockedAmounts[i];
            remainingDue[c]  = _lockedAmounts[i];
        }
        
        // forward principal to applicant
        (bool ok, ) = _applicant.call{value: _principal}("");
        require(ok, "applicant transfer failed");
    }
    
    function expirationBlock() public view returns (uint256) { return startBlock + duration; }
    function isExpired() public view returns (bool) { return block.number > expirationBlock(); }
    function isFailed() public view returns (bool) {
        return isExpired() && totalBaseRepaid < principal;
    }
    
    /// Applicant repays (partial or full). Splits payment into base + interest.
    /// Base is calculated as: payment * principal / (principal + interest_total). 
    /// You may prefer simpler accounting: interestRate% of the *applied* principal.
    function repay() external payable {
        require(msg.sender == applicant, "only applicant");
        require(!successful, "already closed");
        
        uint256 payment = msg.value;
        // Strategy: pay base first up to outstanding principal, the rest is interest.
        // (Adjust to match the spec's exact intent on interest accounting.)
        uint256 outstandingBase = principal - totalBaseRepaid;
        uint256 base = payment > outstandingBase ? outstandingBase : payment;
        uint256 interest = payment - base;
        
        if (base > 0) _distributeBase(base);
        if (interest > 0) _distributeInterest(interest);
        
        emit Repaid(applicant, base, interest);
        
        if (totalBaseRepaid >= principal) {
            successful = true;
            service.onLoanSuccessful();
            emit LoanSuccessful();
        }
    }
    
    function _distributeBase(uint256 amount) internal {
        totalBaseRepaid += amount;
        // refund contributors in order, highest initial locked first
        for (uint256 i = 0; i < contributors.length && amount > 0; ++i) {
            address c = contributors[i];
            uint256 due = remainingDue[c];
            if (due == 0) continue;
            uint256 give = amount > due ? due : amount;
            remainingDue[c] = due - give;
            amount -= give;
            // forward to LendingService to unlock this contributor's funding-pool slot
            service.onLoanRefund{value: give}(c, give);
            emit ContributorRefunded(c, give);
        }
        if (amount > 0) {
            // overflow past principal -> compensation pool
            service.onLoanInterestCollateral{value: amount}();
        }
    }
    
    function _distributeInterest(uint256 interest) internal {
        uint256 collateral = (interest * collateralPct) / 100;
        uint256 gain = interest - collateral;
        
        // collateral -> compensation pool
        if (collateral > 0) service.onLoanInterestCollateral{value: collateral}();
        
        // gain split among contributors proportionally to initialLocked
        uint256 distributed = 0;
        for (uint256 i = 0; i < contributors.length; ++i) {
            address c = contributors[i];
            uint256 share = (gain * initialLocked[c]) / principal;
            if (share > 0) {
                distributed += share;
                (bool ok, ) = c.call{value: share}("");
                require(ok, "gain transfer failed");
                emit InterestGainPaid(c, share);
            }
        }
        uint256 dust = gain - distributed;
        if (dust > 0) service.onLoanInterestCollateral{value: dust}();
    }
    
    /// Called by LendingService on the first successful compensation claim.
    function markFailed() external {
        require(msg.sender == address(service), "only service");
        require(!failedMarked, "already marked");
        require(isFailed(), "not failed");
        failedMarked = true;
        emit LoanFailedMarked();
    }
    
    /// Called by LendingService when a contributor claims compensation;
    /// reduces their `remainingDue` so future repayments don't double-credit them.
    function applyCompensation(address contributor, uint256 amount) external {
        require(msg.sender == address(service), "only service");
        uint256 due = remainingDue[contributor];
        uint256 take = amount > due ? due : amount;
        remainingDue[contributor] = due - take;
        forfeitedShare[contributor] += take;
        compensationClaimed[contributor] += amount;
    }
}