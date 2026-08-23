import { describe, expect, it } from 'vitest';
import { actualBps, apportion, planDeposit, type RebalanceAccount, type RebalanceSleeve } from './rebalance';

/** The five sleeves from the target allocation diagram. */
const sleeves = (holdings: Partial<Record<string, number>> = {}): RebalanceSleeve[] => [
  { id: 'us_equity', accountId: 'rrsp', targetBps: 4500, holdingCents: holdings.us_equity ?? 0 },
  { id: 'cad_bonds', accountId: 'rrsp', targetBps: 1000, holdingCents: holdings.cad_bonds ?? 0 },
  { id: 'cad_equity', accountId: 'tfsa', targetBps: 2000, holdingCents: holdings.cad_equity ?? 0 },
  { id: 'intl_equity', accountId: 'tfsa', targetBps: 1500, holdingCents: holdings.intl_equity ?? 0 },
  { id: 'em_equity', accountId: 'non_registered', targetBps: 1000, holdingCents: holdings.em_equity ?? 0 },
];

const roomy: RebalanceAccount[] = [
  { id: 'rrsp', roomRemainingCents: 100_000_000 },
  { id: 'tfsa', roomRemainingCents: 100_000_000 },
  { id: 'non_registered', roomRemainingCents: null },
];

const byId = (plan: ReturnType<typeof planDeposit>) =>
  Object.fromEntries(plan.lines.map((l) => [l.sleeveId, l.amountCents]));

describe('apportion', () => {
  it('splits exactly, losing no units to rounding', () => {
    const parts = apportion([1n, 1n, 1n], 100n);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(100n);
    expect(parts).toEqual([34n, 33n, 33n]);
  });

  it('returns zeros when there is nothing to split', () => {
    expect(apportion([1n, 2n], 0n)).toEqual([0n, 0n]);
    expect(apportion([0n, 0n], 500n)).toEqual([0n, 0n]);
  });

  it('stays exact at amounts that overflow float precision', () => {
    const total = 900_000_000_000_000_000n; // $9 quadrillion in cents
    const parts = apportion([4500n, 1000n, 2000n, 1500n, 1000n], total);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
  });
});

describe('planDeposit into an empty portfolio', () => {
  it('lands exactly on the target weights', () => {
    const plan = planDeposit(sleeves(), roomy, 1_000_000); // $10,000
    expect(byId(plan)).toEqual({
      us_equity: 450_000,
      cad_bonds: 100_000,
      cad_equity: 200_000,
      intl_equity: 150_000,
      em_equity: 100_000,
    });
    expect(plan.unallocatedCents).toBe(0);
  });
});

describe('planDeposit with drift', () => {
  it('starves the overweight sleeve and feeds the underweight ones', () => {
    // US equity is far over target; Canadian equity is far under.
    const plan = planDeposit(
      sleeves({ us_equity: 4_680_000, cad_bonds: 900_000, cad_equity: 990_000, intl_equity: 1_350_000, em_equity: 900_000 }),
      roomy,
      1_000_000,
    );
    const got = byId(plan);
    expect(got.us_equity).toBe(0);
    expect(got.cad_equity).toBeGreaterThan(got.intl_equity);
    expect(plan.allocatedCents).toBe(1_000_000);
  });

  it('reaches the targets exactly when the deposit is large enough to cover every shortfall', () => {
    const holdings = { us_equity: 0, cad_bonds: 0, cad_equity: 500_000, intl_equity: 0, em_equity: 0 };
    // No sleeve is overweight relative to the post-deposit total, so all needs are met.
    const plan = planDeposit(sleeves(holdings), roomy, 100_000_000);
    const total = 100_000_000 + 500_000;
    for (const line of plan.lines) {
      const sleeve = sleeves(holdings).find((s) => s.id === line.sleeveId)!;
      const finalValue = sleeve.holdingCents + line.amountCents;
      expect(Math.abs(finalValue - (total * sleeve.targetBps) / 10_000)).toBeLessThanOrEqual(1);
    }
  });
});

describe('contribution room capping', () => {
  it('caps the account and reports the shortfall as unallocated cash', () => {
    const accounts: RebalanceAccount[] = [
      { id: 'rrsp', roomRemainingCents: 100_000 }, // only $1,000 of room
      { id: 'tfsa', roomRemainingCents: 100_000_000 },
      { id: 'non_registered', roomRemainingCents: null },
    ];
    const plan = planDeposit(sleeves(), accounts, 1_000_000);
    const got = byId(plan);

    expect(got.us_equity + got.cad_bonds).toBe(100_000);
    expect(plan.cappedAccountIds).toEqual(['rrsp']);
    // The blocked $4,500 stays as cash rather than moving to another account.
    expect(plan.unallocatedCents).toBe(450_000);
    expect(got.cad_equity).toBe(200_000);
    expect(got.em_equity).toBe(100_000);
  });

  it('allocates nothing to an account with no room left', () => {
    const accounts: RebalanceAccount[] = [
      { id: 'rrsp', roomRemainingCents: 0 },
      { id: 'tfsa', roomRemainingCents: 0 },
      { id: 'non_registered', roomRemainingCents: null },
    ];
    const plan = planDeposit(sleeves(), accounts, 1_000_000);
    expect(plan.allocatedCents).toBe(100_000); // emerging markets only
    expect(plan.unallocatedCents).toBe(900_000);
    expect(plan.cappedAccountIds).toEqual(['rrsp', 'tfsa']);
  });

  it('treats negative remaining room as zero', () => {
    const accounts: RebalanceAccount[] = [
      { id: 'rrsp', roomRemainingCents: -500_000 },
      { id: 'tfsa', roomRemainingCents: 100_000_000 },
      { id: 'non_registered', roomRemainingCents: null },
    ];
    const plan = planDeposit(sleeves(), accounts, 1_000_000);
    expect(byId(plan).us_equity).toBe(0);
    expect(byId(plan).cad_bonds).toBe(0);
  });
});

describe('invariants', () => {
  it('never loses or invents a cent, across many random deposits', () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };

    for (let trial = 0; trial < 500; trial++) {
      const holdings = {
        us_equity: rand(9_000_000),
        cad_bonds: rand(9_000_000),
        cad_equity: rand(9_000_000),
        intl_equity: rand(9_000_000),
        em_equity: rand(9_000_000),
      };
      const accounts: RebalanceAccount[] = [
        { id: 'rrsp', roomRemainingCents: rand(2_000_000) },
        { id: 'tfsa', roomRemainingCents: rand(2_000_000) },
        { id: 'non_registered', roomRemainingCents: null },
      ];
      const deposit = 1 + rand(5_000_000);
      const plan = planDeposit(sleeves(holdings), accounts, deposit);

      expect(plan.allocatedCents + plan.unallocatedCents).toBe(deposit);
      expect(plan.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(plan.allocatedCents);
      expect(plan.lines.every((l) => l.amountCents >= 0 && l.blockedCents >= 0)).toBe(true);

      for (const account of accounts) {
        if (account.roomRemainingCents === null) continue;
        const used = plan.lines
          .filter((l) => l.accountId === account.id)
          .reduce((s, l) => s + l.amountCents, 0);
        expect(used).toBeLessThanOrEqual(Math.max(0, account.roomRemainingCents));
      }
    }
  });

  it('rejects deposits that are not a positive whole number of cents', () => {
    expect(() => planDeposit(sleeves(), roomy, 0)).toThrow(RangeError);
    expect(() => planDeposit(sleeves(), roomy, -100)).toThrow(RangeError);
    expect(() => planDeposit(sleeves(), roomy, 10.5)).toThrow(RangeError);
  });
});

describe('actualBps', () => {
  it('reports the current share of the portfolio', () => {
    expect(actualBps(5_000, 10_000)).toBe(5_000);
    expect(actualBps(4_500, 10_000)).toBe(4_500);
  });

  it('returns zero for an empty portfolio instead of dividing by zero', () => {
    expect(actualBps(0, 0)).toBe(0);
    expect(actualBps(100, 0)).toBe(0);
  });

  it('truncates rather than rounding, so shares never overstate', () => {
    // 1/3 is 3333.33 bps; reporting 3334 would sum the five sleeves past 100%.
    expect(actualBps(1, 3)).toBe(3_333);
    expect(actualBps(2, 3)).toBe(6_666);
  });

  it('can exceed 100% when one sleeve holds more than the total', () => {
    expect(actualBps(150, 100)).toBe(15_000);
  });
});

describe('sleeves excluded from the target', () => {
  it('never funds a sleeve whose target is zero', () => {
    const withZero: RebalanceSleeve[] = [
      { id: 'zero', accountId: 'non_registered', targetBps: 0, holdingCents: 0 },
      { id: 'all', accountId: 'non_registered', targetBps: 10_000, holdingCents: 0 },
    ];
    const plan = planDeposit(withZero, [{ id: 'non_registered', roomRemainingCents: null }], 500_000);
    expect(plan.lines.find((l) => l.sleeveId === 'zero')!.amountCents).toBe(0);
    expect(plan.lines.find((l) => l.sleeveId === 'all')!.amountCents).toBe(500_000);
  });
});

describe('unlimited contribution room', () => {
  it('never caps an account whose room is null, however large the deposit', () => {
    const onlyNonRegistered: RebalanceSleeve[] = [
      { id: 'em_equity', accountId: 'non_registered', targetBps: 10_000, holdingCents: 0 },
    ];
    const plan = planDeposit(
      onlyNonRegistered,
      [{ id: 'non_registered', roomRemainingCents: null }],
      500_000_000_00,
    );
    expect(plan.allocatedCents).toBe(500_000_000_00);
    expect(plan.unallocatedCents).toBe(0);
    expect(plan.cappedAccountIds).toEqual([]);
  });
});

describe('the on-target invariant', () => {
  it('lands every sleeve exactly on target when none is overweight', () => {
    // The engine's contract: with no overweight sleeve the shortfalls sum to the
    // deposit exactly, so each sleeve receives precisely what it needs.
    const holdings = {
      us_equity: 450_000,
      cad_bonds: 100_000,
      cad_equity: 200_000,
      intl_equity: 150_000,
      em_equity: 100_000,
    };
    const deposit = 1_000_000;
    const plan = planDeposit(sleeves(holdings), roomy, deposit);
    const total = Object.values(holdings).reduce((a, b) => a + b, 0) + deposit;

    for (const line of plan.lines) {
      const before = holdings[line.sleeveId as keyof typeof holdings];
      const target = sleeves().find((s) => s.id === line.sleeveId)!.targetBps;
      expect(before + line.amountCents).toBe((total * target) / 10_000);
    }
    expect(plan.unallocatedCents).toBe(0);
  });
});
