// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./Loan.sol";

interface IOracle {
    function getBalance(bytes calldata btcAddr) external view returns (uint256);
}

contract LendingService is ILendingServiceCallback {
    // ---- constants ----
    uint256 public constant MIN_DEPOSIT = 100_000 wei;
    uint256 public constant PROPOSAL_VOTING_PERIOD = 12;
    uint256 public constant BTC_ETH_RATE = 30;   // 1 BTC = 30 ETH
    uint256 public constant SATOSHIS_PER_BTC = 1e8;
    
    // ---- admin / upgradability hook ----
    address public admin;
    address public successor;        // set when migrating to a new version
    bool    public terminated;
    
    // ---- funding pool ----
    mapping(address => uint256) public deposited;     // total deposited
    mapping(address => uint256) public locked;        // currently locked in active loans
    address[] public contributorList;
    mapping(address => bool) public isContributor;
    mapping(address => uint256) private contributorIndex;
    uint256 public totalDeposited;
    uint256 public totalLocked;
    
    // ---- compensation pool ----
    uint256 public compensationPool;
    
    // ---- collateral percentage ----
    uint8 public collateralPct = 50;
    
    // ---- oracle ----
    IOracle public oracle;
    
    // ---- proposals ----
    enum Vote { None, Approve, Reject }
    struct Proposal {
        address applicant;
        uint256 amount;
        uint8   interestRate;
        uint256 duration;
        bytes   btcAddress;
        uint256 startBlock;
        bool    closed;
        bool    approved;
        mapping(address => Vote) votes;
    }
    uint256 public nextProposalId;
    mapping(uint256 => Proposal) private proposals;
    
    // ---- loans ----
    mapping(address => bool) public isActiveLoan; // contract address => active
    mapping(address => address[]) public loansByApplicant;
    
    // ---- events ----
    event Deposited(address indexed who, uint256 amount);
    event Withdrawn(address indexed who, uint256 amount);
    event ProposalSubmitted(uint256 indexed id, address indexed applicant, uint256 amount,
                            uint8 interestRate, uint256 duration, bytes btcAddress);
    event Voted(uint256 indexed id, address indexed voter, Vote vote);
    event ProposalResolved(uint256 indexed id, bool approved, address loanContract);
    event CompensationClaimed(address indexed contributor, address indexed loan, uint256 amount);
    event ServiceTerminated(address indexed successor);
    
    modifier onlyAdmin()  { require(msg.sender == admin, "not admin"); _; }
    modifier notTerminated() { require(!terminated, "terminated"); _; }
    
    constructor(address _oracle) {
        admin = msg.sender;
        oracle = IOracle(_oracle);
    }
    
    // ============ contributor operations ============
    
    function deposit() external payable notTerminated {
        require(msg.value >= MIN_DEPOSIT, "below min deposit");
        if (!isContributor[msg.sender]) {
            isContributor[msg.sender] = true;
            contributorIndex[msg.sender] = contributorList.length; // index before push
            contributorList.push(msg.sender);
        }
        deposited[msg.sender] += msg.value;
        totalDeposited += msg.value;
        emit Deposited(msg.sender, msg.value);
    }
    
    function withdraw(uint256 amount) external notTerminated {
        uint256 disposable = _disposable(msg.sender);
        require(amount <= disposable, "exceeds disposable");

        deposited[msg.sender] -= amount;
        totalDeposited -= amount;

        if (deposited[msg.sender] == 0 && locked[msg.sender] == 0) {
            _removeContributor(msg.sender);
        }


        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        emit Withdrawn(msg.sender, amount);
    }
    
    function vote(uint256 proposalId, bool approve) external notTerminated {
        Proposal storage p = proposals[proposalId];
        require(p.applicant != address(0), "no proposal");
        require(!p.closed, "closed");
        require(block.number <= p.startBlock + PROPOSAL_VOTING_PERIOD, "voting window closed");
        require(deposited[msg.sender] > 0, "not a contributor");
        p.votes[msg.sender] = approve ? Vote.Approve : Vote.Reject;
        emit Voted(proposalId, msg.sender, p.votes[msg.sender]);
    }
    
    function claimCompensation(address payable loanAddr) external notTerminated {
        Loan loan = Loan(loanAddr);
        require(loan.isFailed(), "loan not failed");
        uint256 stillOwed = loan.remainingDue(msg.sender);
        require(stillOwed > 0, "nothing owed");
        
        // mark failed on first claim
        if (!loan.failedMarked()) {
            loan.markFailed();
            _onLoanOutcome(false);
        }
        
        uint256 give = stillOwed > compensationPool ? compensationPool : stillOwed;
        require(give > 0, "compensation pool empty");
        compensationPool -= give;
        
        // unlock contributor's funding pool position for the compensated portion
        locked[msg.sender] -= give;
        totalLocked -= give;
        deposited[msg.sender] -= give;   // they got cash, so reduce their pool balance
        totalDeposited -= give;

        if (deposited[msg.sender] == 0 && locked[msg.sender] == 0) {
            _removeContributor(msg.sender);
        }
        
        loan.applyCompensation(msg.sender, give);
        
        (bool ok, ) = msg.sender.call{value: give}("");
        require(ok, "transfer failed");
        emit CompensationClaimed(msg.sender, loanAddr, give);
    }
    
    // ============ applicant operations ============
    
    function submitProposal(uint256 amount, uint8 interestRate, uint256 duration, bytes calldata btcAddress) external notTerminated returns (uint256) {
        require(interestRate >= 1 && interestRate <= 100, "rate out of range");
        require(amount > 0 && duration > 0, "bad params");
        id = nextProposalId++;
        Proposal storage p = proposals[id];
        p.applicant    = msg.sender;
        p.amount       = amount;
        p.interestRate = interestRate;
        p.duration     = duration;
        p.btcAddress   = btcAddress;
        p.startBlock   = block.number;
        emit ProposalSubmitted(id, msg.sender, amount, interestRate, duration, btcAddress);
        return id;
    }
    
    function resolveProposal(uint256 id) external notTerminated {
    Proposal storage p = proposals[id];
    require(p.applicant == msg.sender, "not applicant");
    require(!p.closed, "closed");
    require(block.number > p.startBlock + PROPOSAL_VOTING_PERIOD, "too early");

    uint256 cumDisposable = _cumulativeDisposable();

    // reject paths: insufficient pool OR failed liquidity check
    if (cumDisposable < p.amount || !_passesLiquidity(p.btcAddress, p.amount)) {
        p.closed = true;
        emit ProposalResolved(id, false, address(0));
        return;
    }

    // weighted vote (non-voters count as reject via cumDisposable)
    uint256 approveWeight = _approveWeight(p);
    if (approveWeight <= cumDisposable - approveWeight) {
        p.closed = true;
        emit ProposalResolved(id, false, address(0));
        return;
    }

    // approved
    address loanAddr = _createLoan(p, cumDisposable);
    p.closed = true;
    p.approved = true;
    emit ProposalResolved(id, true, loanAddr);
}

function _cumulativeDisposable() internal view returns (uint256) {
    uint256 n = contributorList.length;
    for (uint256 i = 0; i < n; ++i) {
        total += _disposable(contributorList[i]);
    }
    return total;
}

function _passesLiquidity(bytes storage btcAddr, uint256 amount) internal view returns (bool){
    uint256 sats = oracle.getBalance(btcAddr);
    uint256 ethEquiv = (sats * BTC_ETH_RATE * 1 ether) / SATOSHIS_PER_BTC;
    return ethEquiv >= amount;
}

function _approveWeight(Proposal storage p) internal view returns (uint256){
    uint256 n = contributorList.length;
    for (uint256 i = 0; i < n; ++i) {
        address c = contributorList[i];
        if (p.votes[c] == Vote.Approve) {
            weight += _disposable(c);
        }
    }
    return weight;
}

function _createLoan(Proposal storage p, uint256 cumDisposable) internal returns (address){
    (address[] memory sorted, uint256[] memory amounts, uint256 actualPrincipal)
        = _lockProportional(p.amount, cumDisposable);

    Loan loan = (new Loan){value: actualPrincipal}(
        p.applicant, actualPrincipal, p.interestRate, p.duration,
        collateralPct, p.btcAddress, sorted, amounts
    );
    isActiveLoan[address(loan)] = true;
    loansByApplicant[p.applicant].push(address(loan));
    return address(loan);
}
    
    // ============ helpers ============
    
    function _disposable(address c) internal view returns (uint256) {
        return deposited[c] - locked[c];
    }
    
    function _lockProportional(uint256 amount, uint256 cumDisposable) internal
    returns (address[] memory sorted, uint256[] memory amounts, uint256 actualPrincipal){
        uint256 n = contributorList.length;
        address[] memory active = new address[](n);
        uint256[] memory locks  = new uint256[](n);
        uint256 cnt = 0;
        uint256 sumLocked = 0;
        
        for (uint256 i = 0; i < n; ++i) {
            address c = contributorList[i];
            uint256 d = _disposable(c);
            if (d == 0) continue;
            uint256 take = (amount * d) / cumDisposable; // integer division -> discrepancy
            if (take == 0) continue;
            active[cnt] = c;
            locks[cnt]  = take;
            cnt++;
            sumLocked += take;
            locked[c] += take;
        }
        totalLocked += sumLocked;
        actualPrincipal = sumLocked; // discrepancy absorbed: applicant receives the actual sum
        
        // sort active[0..cnt) by locks desc, address asc — selection sort (gas-expensive but ok for exercise)
        sorted  = new address[](cnt);
        amounts = new uint256[](cnt);
        bool[] memory used = new bool[](cnt);
        for (uint256 i = 0; i < cnt; ++i) {
            uint256 bestIdx = type(uint256).max;
            for (uint256 j = 0; j < cnt; ++j) {
                if (used[j]) continue;
                if (bestIdx == type(uint256).max) { bestIdx = j; continue; }
                if (locks[j] > locks[bestIdx]) bestIdx = j;
                else if (locks[j] == locks[bestIdx] && active[j] < active[bestIdx]) bestIdx = j;
            }
            used[bestIdx] = true;
            sorted[i]  = active[bestIdx];
            amounts[i] = locks[bestIdx];
        }
    }
    
    function _onLoanOutcome(bool success) internal {
        if (success) {
            if (collateralPct > 5) collateralPct -= 5;
            else collateralPct = 1;
        } else {
            if (collateralPct < 95) collateralPct += 5;
            else collateralPct = 100;
        }
    }


    function _removeContributor(address who) internal {
        isContributor[who] = false;

        uint256 idx = contributorIndex[who];
        uint256 lastIdx = contributorList.length - 1;

        if (idx != lastIdx) {
            address lastAddr = contributorList[lastIdx];
            contributorList[idx] = lastAddr;       // move last element into the gap
            contributorIndex[lastAddr] = idx;      // update the moved element's index
        }
        contributorList.pop();                     // drop the now-duplicate tail
        delete contributorIndex[who];
    }
    
    // ============ callbacks invoked by Loan contracts ============
    
    function onLoanRefund(address contributor, uint256 baseAmount) external payable override {
        require(isActiveLoan[msg.sender], "not a known loan");
        require(msg.value == baseAmount, "amount mismatch");
        locked[contributor] -= baseAmount;
        totalLocked -= baseAmount;
        // deposited stays the same: the contributor's funding-pool position is restored
    }
    
    function onLoanInterestCollateral() external payable override {
        require(isActiveLoan[msg.sender], "not a known loan");
        compensationPool += msg.value;
    }
    
    function onLoanSuccessful() external override {
        require(isActiveLoan[msg.sender], "not a known loan");
        isActiveLoan[msg.sender] = false;
        _onLoanOutcome(true);
    }
    
    function onLoanFailedMarked() external override {
        // already handled in claimCompensation
    }
    
    // ============ admin / upgradability ============
    
    function setSuccessor(address _successor) external onlyAdmin { successor = _successor; }
    
    function terminate() external onlyAdmin {
        require(successor != address(0), "no successor");
        require(totalLocked == 0, "loans still active");
        terminated = true;
        // migrate ETH balance to successor
        uint256 bal = address(this).balance;
        (bool ok, ) = successor.call{value: bal}("");
        require(ok, "migration transfer failed");
        emit ServiceTerminated(successor);
    }
    
    receive() external payable {}
}