# Malicious contributor strategy without reentrancy

The spec asks whether a contributor can gain **unfair remuneration at the expense
of honest contributors** by leveraging the service's own rules — repayment
ordering, proportional locking, and the compensation pool — rather than by a
low-level exploit like reentrancy. The answer is yes. Below are two concrete
strategies, why each is profitable at others' expense, and how the design could
be changed to remove the edge.

---

## Strategy 1 — Refund-priority capture via the highest-locked-first rule

**The rule being leveraged.** When a loan is (partially) repaid, base is refunded
to contributors *in order of locked value, highest first* (ties broken by
address). A partial repayment therefore fully refunds the largest lockholders
before smaller ones receive anything. If the loan is *only partially* repaid and
then fails, the contributors near the front of the order were made whole by real
repayment, while those at the back are left owed and must fall back on the
compensation pool — which may be empty or insufficient.

**The strategy.** A contributor deliberately makes their locked stake in a loan
the **largest**, so they sit at the front of the refund order. Because locking is
proportional to disposable value at resolution time, the attacker can do this by
**timing a large deposit just before `resolveProposal`** is called on a proposal
they expect to be only partially serviced (e.g. a risky, high-interest loan).
When that loan is created, the attacker gets the biggest proportional lock, hence
first-in-line refund priority. If the borrower makes any partial repayment before
defaulting, the attacker captures it; the honest smaller contributors get nothing
from the borrower and are pushed onto the (finite) compensation pool.

**Why it's unfair.** Repayment from the borrower is *certain money*; compensation
from the pool is *contingent and capped*. By engineering front-of-line position,
the attacker converts their exposure into the certain tranche and offloads the
risky tranche onto honest contributors. Over many loans, the attacker
systematically collects real repayments while honest contributors
disproportionately absorb defaults. The attacker can then withdraw once the loan
resolves, having borne risk for only a short, well-chosen window.

**This is the "repayment majority" edge.** Being the largest lockholder gives the
attacker the majority share of any partial repayment — a *de facto* priority
claim — without any corresponding priority in bearing losses.

---

## Strategy 2 — Winning the compensation-claim race

**The rule being leveraged.** On a failed loan, `claimCompensation` pays
`min(amountOwed, compensationPool)` to whoever calls it, decrementing the single
**global** pool. It is first-come, first-served: the pool is not escrowed
per-loan or split pro-rata among a failed loan's contributors.

**The strategy.** When a loan fails and the pool is smaller than the total owed
to its contributors, the attacker races to call `claimCompensation` **first**
(e.g. by monitoring the mempool / block for the loan's expiry and submitting with
a high priority fee). The first claimant is paid in full up to the pool balance;
slower honest contributors find the pool drained and receive little or nothing.

**Why it's unfair.** All contributors of the failed loan have an equal, symmetric
claim on the shared insurance pool, but the ordering is decided purely by
transaction timing, not by fairness. A sophisticated contributor who automates
monitoring will consistently beat honest participants to a limited pool,
extracting more than their proportional share of the insurance fund.

---

## Why neither needs reentrancy

Both strategies use only the contract's *intended* external functions
(`deposit`, `resolveProposal` timing, `claimCompensation`) in a legal order.
Nothing re-enters a half-updated function; the unfairness comes from the
**economic rules** (ordered refunds, timing-based lock sizing, first-come global
pool), not from a state-consistency bug. That is exactly what makes them harder
to dismiss than a reentrancy hole: the contract behaves "correctly" per its code.

---

## Mitigations

**Against Strategy 1 (refund-priority capture):**

- **Pro-rata refunds instead of ordered refunds.** Distribute each (partial)
  repayment to *all* current lockholders in proportion to their remaining
  `remainingDue`, rather than fully paying the largest first. Then no position in
  an ordering confers an advantage, and partial repayments are shared fairly.
- **Lock the participation snapshot / add a deposit time-lock.** Prevent a
  deposit made immediately before `resolveProposal` from participating in that
  resolution (e.g. require funds to have been deposited for N blocks to count
  toward a loan's lock). This removes the "just-in-time deposit to grab priority"
  move, since the attacker can no longer size their lock on demand.

**Against Strategy 2 (compensation race):**

- **Per-loan escrowed, pro-rata compensation.** Instead of a single global pool
  paid first-come, allocate a failed loan's compensable amount pro-rata across
  its contributors and let each withdraw only their computed share. Timing then
  cannot let one contributor take another's share.
- **Claim windows / batch settlement.** Require compensation for a failed loan to
  be settled in a single batched step (or after a fixed window during which all
  affected contributors register), then split what's available proportionally —
  again decoupling payout from transaction ordering.

**General:** both classes of unfairness stem from *ordering-sensitive* payouts
(refunds ordered by lock size; compensation ordered by call time). Replacing
ordering-sensitive distribution with **proportional, order-independent**
distribution is the single structural change that removes the incentive to game
either rule. The cost is higher gas (pro-rata loops touch every contributor) and
more complex accounting — the same scalability tension already noted for the
proportional-locking sort — but it is what makes the mechanism strategy-proof
against these non-reentrancy attacks.
