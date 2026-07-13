// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./Loan.sol";

interface Oracle_Interface {
    function get_balance(string calldata BTC_addr) external view returns (uint256);
}

contract LendingService is Loan_Service_Interface {
    uint256 public constant MIN_DEPOSIT = 100_000 wei;
    uint256 public constant SATOSHIS_PER_BTC = 1e8;
    uint256 public constant BTC_ETH_RATE = 30;   //1 btc = 30 eth
    uint256 public constant PROPOSAL_VOTING_PERIOD = 12;
    
    address public admin;
    address public pending_admin;
    bool    public terminated;
    address public successor;        //set when migrating to a new version
    
    mapping(address => uint256) public deposited;
    mapping(address => uint256) public locked;
    mapping(address => bool) public is_contributor;
    mapping(address => uint256) private contributor_index;
    address[] public contributor_list;
    uint256 public total_deposited;
    uint256 public total_locked;
    
    uint8 public collateral_percent = 50;
    uint256 public compensation_pool;    

    //needed to call get_balance    
    Oracle_Interface public oracle;
    
    enum Vote { None, Approve, Reject }
    struct Proposal {
        address applicant;
        uint8   interest_rate;
        uint256 amount;
        string   loan_BTC_address;
        uint256 duration;
        bool    closed;
        bool    approved;
        uint256 loan_start_block;
        mapping(address => Vote) votes;
    }

    mapping(uint256 => Proposal) private proposals;
    uint256 public next_proposal_id;
    mapping(address => bool) public active_loan; //contract address => active
    
    event Deposited(address indexed contributor, uint256 amount);
    event Withdrawn(address indexed contributor, uint256 amount);
    event Voted(uint256 indexed id, address indexed voter, Vote vote);
    event proposal_submitted(uint256 indexed id, address indexed applicant, uint256 amount, uint8 interest_rate, uint256 duration, string loan_BTC_address);
    event proposal_resolved(uint256 indexed id, bool approved, address loan_contract);
    event service_terminated(address indexed successor);
    event compensation_claimed(address indexed contributor, address indexed loan, uint256 amount);
    event admin_transfer_start(address indexed current_admin, address indexed pending_admin);
    event oracle_updated(address indexed previous_oracle, address indexed new_oracle);
    event admin_transfer_complete(address indexed previous_admin, address indexed new_admin);
    
    modifier only_admin()  { require(msg.sender == admin, "not admin"); _; }
    modifier not_terminated() { require(!terminated, "terminated"); _; }
    
    constructor(address _oracle) {
        admin = msg.sender;
        oracle = Oracle_Interface(_oracle);
    }
        
    //contributors
    function deposit() external payable not_terminated {
        require(msg.value >= MIN_DEPOSIT, "below min deposit");

        if (!is_contributor[msg.sender]) {
            is_contributor[msg.sender] = true;
            contributor_index[msg.sender] = contributor_list.length;
            contributor_list.push(msg.sender);
        }

        deposited[msg.sender] += msg.value;
        total_deposited += msg.value;

        emit Deposited(msg.sender, msg.value);
    }
    
    function withdraw(uint256 amount) external not_terminated {
        uint256 disposable = disposable_calculation(msg.sender);
        require(amount <= disposable, "exceeds disposable");

        deposited[msg.sender] -= amount;
        total_deposited -= amount;

        if (deposited[msg.sender] == 0 && locked[msg.sender] == 0) {
            remove_contributor(msg.sender);
        }

        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");

        emit Withdrawn(msg.sender, amount);
    }
    
    function vote(uint256 proposal_id, bool approve) external not_terminated {
        Proposal storage p = proposals[proposal_id];

        require(p.applicant != address(0), "no proposal");
        require(!p.closed, "closed");
        require(block.number <= p.loan_start_block + PROPOSAL_VOTING_PERIOD, "voting window closed");
        require(deposited[msg.sender] > 0, "not a contributor");

        p.votes[msg.sender] = approve ? Vote.Approve : Vote.Reject;

        emit Voted(proposal_id, msg.sender, p.votes[msg.sender]);
    }
    
    function claim_compensation(address loan_addr) external not_terminated {
        Loan loan = Loan(loan_addr);

        require(loan.is_failed(), "loan not failed");
        uint256 still_owed = loan.remaining_due(msg.sender);
        require(still_owed > 0, "nothing owed");
        
        //it gets makred as failed on the first compensation request
        if (!loan.failed_marked()) {
            loan.mark_failed();
            loan_outcome(false);
        }
        
        uint256 compensation = still_owed > compensation_pool ? compensation_pool : still_owed;
        require(compensation > 0, "compensation pool empty");

        compensation_pool -= compensation;
        locked[msg.sender] -= compensation;
        total_locked -= compensation;
        deposited[msg.sender] -= compensation;
        total_deposited -= compensation;

        if (deposited[msg.sender] == 0 && locked[msg.sender] == 0) {
            remove_contributor(msg.sender);
        }
        
        loan.apply_compensation(msg.sender, compensation);
        
        (bool ok, ) = msg.sender.call{value: compensation}("");
        require(ok, "transfer failed");

        emit compensation_claimed(msg.sender, loan_addr, compensation);
    }
    
    //applicants
    
    function submit_proposal(uint256 amount, uint8 interest_rate, uint256 duration, string calldata loan_BTC_address) external not_terminated returns (uint256 id) {
        require(interest_rate >= 1 && interest_rate <= 100, "rate out of range");
        require(amount > 0 && duration > 0, "bad params");

        id = next_proposal_id++;
        Proposal storage p = proposals[id];
        p.applicant    = msg.sender;
        p.amount       = amount;
        p.interest_rate = interest_rate;
        p.duration     = duration;
        p.loan_BTC_address   = loan_BTC_address;
        p.loan_start_block   = block.number;
        
        emit proposal_submitted(id, msg.sender, amount, interest_rate, duration, loan_BTC_address);
        return id;
    }
    
    function resolve_proposal(uint256 id) external not_terminated {
        Proposal storage p = proposals[id];

        require(p.applicant == msg.sender, "not applicant");
        require(!p.closed, "closed");
        require(block.number > p.loan_start_block + PROPOSAL_VOTING_PERIOD, "too early");

        uint256 tot_disposable = total_disposable();

        //rejection reasons: insufficient pool or failed liquidity check
        if (tot_disposable < p.amount || !liquidity_check(p.loan_BTC_address, p.amount)) {
            p.closed = true;
            emit proposal_resolved(id, false, address(0));
            return;
        }

        uint256 approve_weight = weight_calculation(p);
        if (approve_weight <= tot_disposable - approve_weight) {
            p.closed = true;
            emit proposal_resolved(id, false, address(0));
            return;
        }

        //approved
        address loan_addr = create_loan(p, tot_disposable);
        p.closed = true;
        p.approved = true;
        emit proposal_resolved(id, true, loan_addr);
    }

    function total_disposable() internal view returns (uint256 total) {
        uint256 n = contributor_list.length;
        for (uint256 i = 0; i < n; ++i) {
            total += disposable_calculation(contributor_list[i]);
        }
        return total;
    }

    function liquidity_check(string storage BTC_addr, uint256 amount) internal view returns (bool) {
        uint256 sats = oracle.get_balance(BTC_addr);
        uint256 eth_converted = (sats * BTC_ETH_RATE * 1 ether) / SATOSHIS_PER_BTC;
        return eth_converted >= amount;
    }

    function weight_calculation(Proposal storage p) internal view returns (uint256 weight) {
        uint256 n = contributor_list.length;
        for (uint256 i = 0; i < n; ++i) {
            address c = contributor_list[i];
            if (p.votes[c] == Vote.Approve) {
                weight += disposable_calculation(c);
            }
        }
        return weight;
    }

    function create_loan(Proposal storage p, uint256 tot_disposable) internal returns (address) {
        (address[] memory sorted, uint256[] memory amounts, uint256 actual_lent_value) = lock_proportional(p.amount, tot_disposable);

        Loan loan = (new Loan){value: actual_lent_value}(
            p.applicant, 
            actual_lent_value, 
            p.interest_rate, 
            p.duration,
            collateral_percent, 
            sorted, 
            amounts
        );
        active_loan[address(loan)] = true;
        return address(loan);
    }
    
    //helpers
    function disposable_calculation(address c) internal view returns (uint256) {
        return deposited[c] - locked[c];
    }
    
    function lock_proportional(uint256 amount, uint256 tot_disposable) internal returns (address[] memory sorted, uint256[] memory amounts, uint256 actual_lent_value) {
        uint256 n = contributor_list.length;
        address[] memory active = new address[](n);
        uint256[] memory locks  = new uint256[](n);
        uint256 count = 0;
        uint256 will_lock = 0;
        
        for (uint256 i = 0; i < n; ++i) {
            address c = contributor_list[i];
            uint256 d = disposable_calculation(c);
            if (d == 0) continue;
            uint256 will_loan = (amount * d) / tot_disposable; //integer division creates rounding errors
            if (will_loan == 0) continue;
            active[count] = c;          //needed for sorting
            locks[count]  = will_loan;  //needed for sorting
            count++;
            will_lock += will_loan;
            locked[c] += will_loan;
        }
        total_locked += will_lock;
        actual_lent_value = will_lock; //actual_lent_value might be not equal to the requested amount defined in the loan proposal due to rounding errors
        
        //sort the active contributors by descending locked value (locks) and ascending address (active)
        for (uint256 i = 1; i < count; ++i) {
            address a_key = active[i];
            uint256 l_key = locks[i];
            uint256 j = i;
            while (j > 0 && (locks[j-1] < l_key || (locks[j-1] == l_key && active[j-1] > a_key))) {
                active[j] = active[j-1];
                locks[j]  = locks[j-1];
                j--;
            }
            active[j] = a_key;
            locks[j]  = l_key;
        }
        sorted  = new address[](count);
        amounts = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) { sorted[i] = active[i]; amounts[i] = locks[i]; }
    } 
    
    function loan_outcome(bool success) internal {
        if (success) {
            if (collateral_percent > 5) collateral_percent -= 5;
            else collateral_percent = 1;
        } else {
            if (collateral_percent < 95) collateral_percent += 5;
            else collateral_percent = 100;
        }
    }


    function remove_contributor(address contributor) internal {
        is_contributor[contributor] = false;

        uint256 index = contributor_index[contributor];
        uint256 last = contributor_list.length - 1;

        if (index != last) {
            address lastAddr = contributor_list[last];
            contributor_list[index] = lastAddr;       // move last element into the gap
            contributor_index[lastAddr] = index;      // update the moved element's index
        }
        contributor_list.pop();                     // drop the now-duplicate tail
        delete contributor_index[contributor];
    }
    
    //for Loan.sol
    
    function loan_refund(address contributor, uint256 repaid_base_amount) external payable override {
        require(active_loan[msg.sender], "not a known loan");
        require(msg.value == repaid_base_amount, "amount mismatch");

        locked[contributor] -= repaid_base_amount;
        total_locked -= repaid_base_amount;
    }
    
    function loan_collateral() external payable override {
        require(active_loan[msg.sender], "not a known loan");

        compensation_pool += msg.value;
    }
    
    function loan_success() external override {
        require(active_loan[msg.sender], "not a known loan");

        active_loan[msg.sender] = false;
        loan_outcome(true);
    }

    //upgradability
    
    function set_successor(address _successor) external only_admin { successor = _successor; }
    
    function terminate() external only_admin {
        require(successor != address(0), "no successor");
        require(total_locked == 0, "loans still active");

        terminated = true;
        //migrate eth balance to successor
        uint256 bal = address(this).balance;
        (bool ok, ) = successor.call{value: bal}("");

        require(ok, "migration transfer failed");

        emit service_terminated(successor);
    }

    function set_oracle(address new_oracle) external only_admin {
        require(new_oracle != address(0), "zero address");

        address previous = address(oracle);
        oracle = Oracle_Interface(new_oracle);

        emit oracle_updated(previous, new_oracle);
    }

    function transfer_admin(address new_admin) external only_admin {
        require(new_admin != address(0), "zero address");

        pending_admin = new_admin;

        emit admin_transfer_start(admin, new_admin);
    }

    function accept_admin() external {
        require(msg.sender == pending_admin, "not pending admin");

        address previous = admin;
        admin = pending_admin;
        pending_admin = address(0);

        emit admin_transfer_complete(previous, admin);
    }
    
    receive() external payable {}
}