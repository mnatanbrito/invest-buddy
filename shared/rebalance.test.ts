import { describe, expect, it } from 'vitest';
import {
  actualBps,
  apportion,
  effectiveTargetBps,
  effectiveWeight,
  planDeposit,
  type RebalanceAccount,
  type RebalanceUnit,
} from './rebalance';

/** The five sleeves from the target allocation diagram, one asset each (weightBps: 10000). */
const units = (holdings: Partial<Record<string, number>> = {}): RebalanceUnit[] => [
  unit('us_equity', 'rrsp', 'rrsp', 4500, 10_000, holdings.us_equity ?? 0),
  unit('cad_bonds', 'rrsp', 'rrsp', 1000, 10_000, holdings.cad_bonds ?? 0),
  unit('cad_equity', 'tfsa', 'tfsa', 2000, 10_000, holdings.cad_equity ?? 0),
  unit('intl_equity', 'tfsa', 'tfsa', 1500, 10_000, holdings.intl_equity ?? 0),
  unit('em_equity', 'non_registered', 'non_registered', 1000, 10_000, holdings.em_equity ?? 0),
];

function unit(
  id: string,
  sleeveId: string,
  accountId: string,
  sleeveTargetBps: number,
  assetWeightBps: number,
  holdingCents: number,
  ticker: string = id,
): RebalanceUnit {
  return {
    id,
    sleeveId,
    accountId,
    ticker,
    targetWeight: effectiveWeight(sleeveTargetBps, assetWeightBps),
    holdingCents,
  };
}

const roomy: RebalanceAccount[] = [
  { id: 'rrsp', roomRemainingCents: 100_000_000 },
  { id: 'tfsa', roomRemainingCents: 100_000_000 },
  { id: 'non_registered', roomRemainingCents: null },
];

const byId = (plan: ReturnType<typeof planDeposit>) =>
  Object.fromEntries(plan.lines.map((l) => [l.assetId, l.amountCents]));

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
    const plan = planDeposit(units(), roomy, 1_000_000); // $10,000
    expect(byId(plan)).toEqual({
      us_equity: 450_000,
      cad_bonds: 100_000,
      cad_equity: 200_000,
      intl_equity: 150_000,
      em_equity: 100_000,
    });
    expect(plan.unallocatedCents).toBe(0);
  });

  it('splits a deposit within a sleeve according to asset weights', () => {
    const multiAsset: RebalanceUnit[] = [
      unit('vti', 'us_equity', 'rrsp', 10_000, 7000, 0),
      unit('itot', 'us_equity', 'rrsp', 10_000, 3000, 0),
    ];
    const plan = planDeposit(multiAsset, [{ id: 'rrsp', roomRemainingCents: null }], 1_000_000);
    expect(byId(plan)).toEqual({ vti: 700_000, itot: 300_000 });
  });
});

describe('planDeposit with drift', () => {
  it('starves the overweight asset and feeds the underweight ones', () => {
    // US equity is far over target; Canadian equity is far under.
    const plan = planDeposit(
      units({ us_equity: 4_680_000, cad_bonds: 900_000, cad_equity: 990_000, intl_equity: 1_350_000, em_equity: 900_000 }),
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
    // No unit is overweight relative to the post-deposit total, so all needs are met.
    const plan = planDeposit(units(holdings), roomy, 100_000_000);
    const total = 100_000_000 + 500_000;
    for (const line of plan.lines) {
      const u = units(holdings).find((x) => x.id === line.assetId)!;
      const finalValue = u.holdingCents + line.amountCents;
      expect(Math.abs(finalValue - (total * u.targetWeight) / 100_000_000)).toBeLessThanOrEqual(1);
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
    const plan = planDeposit(units(), accounts, 1_000_000);
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
    const plan = planDeposit(units(), accounts, 1_000_000);
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
    const plan = planDeposit(units(), accounts, 1_000_000);
    expect(byId(plan).us_equity).toBe(0);
    expect(byId(plan).cad_bonds).toBe(0);
  });
});

describe('prioritized accounts', () => {
  // The spec's acceptance example: XEQT held in both stock sleeves, ZAG only in bonds.
  const exampleUnits = (): RebalanceUnit[] => [
    unit('rrsp_stock', 'rrsp_stock', 'rrsp', 4500, 10_000, 0, 'XEQT'),
    unit('rrsp_bonds', 'rrsp_bonds', 'rrsp', 1000, 10_000, 0, 'ZAG'),
    unit('tfsa_stock', 'tfsa_stock', 'tfsa', 4500, 10_000, 0, 'XEQT'),
  ];
  const exampleAccounts: RebalanceAccount[] = [
    { id: 'rrsp', roomRemainingCents: 8_790_100 }, // $87,901.00
    { id: 'tfsa', roomRemainingCents: 3_220_085 }, // $32,200.85
  ];

  it('fills the prioritized account to its room and redirects the overflow to the same ticker', () => {
    const plan = planDeposit(exampleUnits(), exampleAccounts, 10_000_000, ['tfsa']);
    expect(byId(plan)).toEqual({
      rrsp_stock: 5_779_915,
      rrsp_bonds: 1_000_000,
      tfsa_stock: 3_220_085,
    });
    expect(plan.unallocatedCents).toBe(0);
    expect(plan.redirectedCents).toBe(1_279_915);
    expect(plan.prioritizedAccountIds).toEqual(['tfsa']);
    expect(plan.cappedAccountIds).toEqual(['tfsa']);

    const bySleeveRedirect = Object.fromEntries(plan.lines.map((l) => [l.assetId, l.redirectedCents]));
    expect(bySleeveRedirect).toEqual({
      rrsp_stock: 1_279_915,
      rrsp_bonds: 0,
      tfsa_stock: -1_279_915,
    });
    expect(plan.lines.reduce((s, l) => s + l.redirectedCents, 0)).toBe(0);
    for (const l of plan.lines) {
      expect(l.amountCents).toBe(l.intendedCents + l.redirectedCents - l.blockedCents);
    }
  });

  it('is a no-op when the prioritized account fits within its room', () => {
    const bare = planDeposit(exampleUnits(), exampleAccounts, 1_000_000);
    const prio = planDeposit(exampleUnits(), exampleAccounts, 1_000_000, ['tfsa']);
    expect(byId(prio)).toEqual(byId(bare));
    expect(prio.redirectedCents).toBe(0);
    expect(prio.cappedAccountIds).toEqual([]);
    expect(prio.prioritizedAccountIds).toEqual(['tfsa']);
  });

  it('is a no-op when the prioritized account has unlimited room', () => {
    const accounts: RebalanceAccount[] = [
      { id: 'rrsp', roomRemainingCents: 8_790_100 },
      { id: 'tfsa', roomRemainingCents: null },
    ];
    const bare = planDeposit(exampleUnits(), accounts, 10_000_000);
    const prio = planDeposit(exampleUnits(), accounts, 10_000_000, ['tfsa']);
    expect(byId(prio)).toEqual(byId(bare));
    expect(prio.redirectedCents).toBe(0);
  });

  it('holds overflow as cash when no non-prioritized sleeve shares the ticker', () => {
    // tfsa_stock is now XEIT, held nowhere else.
    const units: RebalanceUnit[] = [
      unit('rrsp_stock', 'rrsp_stock', 'rrsp', 4500, 10_000, 0, 'XEQT'),
      unit('rrsp_bonds', 'rrsp_bonds', 'rrsp', 1000, 10_000, 0, 'ZAG'),
      unit('tfsa_stock', 'tfsa_stock', 'tfsa', 4500, 10_000, 0, 'XEIT'),
    ];
    const plan = planDeposit(units, exampleAccounts, 10_000_000, ['tfsa']);
    expect(byId(plan)).toEqual({
      rrsp_stock: 4_500_000,
      rrsp_bonds: 1_000_000,
      tfsa_stock: 3_220_085,
    });
    expect(plan.redirectedCents).toBe(0);
    expect(plan.unallocatedCents).toBe(1_279_915);
    const tfsaLine = plan.lines.find((l) => l.assetId === 'tfsa_stock')!;
    expect(tfsaLine.blockedCents).toBe(1_279_915);
    expect(tfsaLine.redirectedCents).toBe(0);
  });

  it('lets redirected cents that overflow a non-prioritized account fall back to cash', () => {
    // RRSP has almost no room, so it cannot absorb the redirect from TFSA.
    const accounts: RebalanceAccount[] = [
      { id: 'rrsp', roomRemainingCents: 4_600_000 }, // fits its own $45k base, little more
      { id: 'tfsa', roomRemainingCents: 3_220_085 },
    ];
    const plan = planDeposit(exampleUnits(), accounts, 10_000_000, ['tfsa']);
    expect(plan.allocatedCents + plan.unallocatedCents).toBe(10_000_000);
    expect(plan.unallocatedCents).toBeGreaterThan(0);
    expect(plan.cappedAccountIds).toEqual(expect.arrayContaining(['tfsa', 'rrsp']));
    for (const l of plan.lines) {
      expect(l.amountCents).toBe(l.intendedCents + l.redirectedCents - l.blockedCents);
      expect(l.blockedCents).toBeGreaterThanOrEqual(0);
    }
    for (const account of accounts) {
      const used = plan.lines
        .filter((l) => l.accountId === account.id)
        .reduce((s, l) => s + l.amountCents, 0);
      expect(used).toBeLessThanOrEqual(account.roomRemainingCents!);
    }
  });

  it('caps two prioritized accounts independently and pools their overflow per ticker', () => {
    const units: RebalanceUnit[] = [
      unit('rrsp_stock', 'rrsp_stock', 'rrsp', 3000, 10_000, 0, 'XEQT'),
      unit('tfsa_stock', 'tfsa_stock', 'tfsa', 3000, 10_000, 0, 'XEQT'),
      unit('nr_stock', 'nr_stock', 'nr', 4000, 10_000, 0, 'XEQT'),
    ];
    const accounts: RebalanceAccount[] = [
      { id: 'rrsp', roomRemainingCents: 1_000_000 },
      { id: 'tfsa', roomRemainingCents: 1_000_000 },
      { id: 'nr', roomRemainingCents: null },
    ];
    const plan = planDeposit(units, accounts, 10_000_000, ['rrsp', 'tfsa']);
    expect(byId(plan)).toEqual({
      rrsp_stock: 1_000_000,
      tfsa_stock: 1_000_000,
      nr_stock: 8_000_000, // its own $4m base + $2m + $2m redirected
    });
    expect(plan.redirectedCents).toBe(4_000_000);
    expect(plan.unallocatedCents).toBe(0);
    expect(plan.lines.reduce((s, l) => s + l.redirectedCents, 0)).toBe(0);
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
      const maybePriority = [
        ...(rand(2) === 0 ? ['rrsp'] : []),
        ...(rand(2) === 0 ? ['tfsa'] : []),
      ];
      const plan = planDeposit(units(holdings), accounts, deposit, maybePriority);

      expect(plan.allocatedCents + plan.unallocatedCents).toBe(deposit);
      expect(plan.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(plan.allocatedCents);
      expect(plan.lines.every((l) => l.amountCents >= 0 && l.blockedCents >= 0)).toBe(true);
      expect(plan.lines.reduce((s, l) => s + l.redirectedCents, 0)).toBe(0);
      for (const l of plan.lines) {
        expect(l.amountCents).toBe(l.intendedCents + l.redirectedCents - l.blockedCents);
        expect(l.blockedCents).toBeGreaterThanOrEqual(0);
      }

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
    expect(() => planDeposit(units(), roomy, 0)).toThrow(RangeError);
    expect(() => planDeposit(units(), roomy, -100)).toThrow(RangeError);
    expect(() => planDeposit(units(), roomy, 10.5)).toThrow(RangeError);
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

describe('effectiveWeight and effectiveTargetBps', () => {
  it('multiplies sleeve target by asset weight, exactly', () => {
    expect(effectiveWeight(4500, 7000)).toBe(31_500_000);
  });

  it('floors the display bps rather than rounding it up', () => {
    // 4500 * 3333 / 10000 = 1499.85 -> floors to 1499, never 1500.
    expect(effectiveTargetBps(4500, 3333)).toBe(1499);
  });

  it('lands on the sleeve target when the asset holds the whole sleeve', () => {
    expect(effectiveTargetBps(4500, 10_000)).toBe(4500);
  });
});

describe('units excluded from the target', () => {
  it('never funds an asset whose effective weight is zero', () => {
    const withZero: RebalanceUnit[] = [
      unit('zero', 'sleeve', 'non_registered', 0, 10_000, 0),
      unit('all', 'sleeve2', 'non_registered', 10_000, 10_000, 0),
    ];
    const plan = planDeposit(withZero, [{ id: 'non_registered', roomRemainingCents: null }], 500_000);
    expect(plan.lines.find((l) => l.assetId === 'zero')!.amountCents).toBe(0);
    expect(plan.lines.find((l) => l.assetId === 'all')!.amountCents).toBe(500_000);
  });
});

describe('unlimited contribution room', () => {
  it('never caps an account whose room is null, however large the deposit', () => {
    const onlyNonRegistered: RebalanceUnit[] = [
      unit('em_equity', 'em_equity', 'non_registered', 10_000, 10_000, 0),
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
  it('lands every asset exactly on target when none is overweight', () => {
    // The engine's contract: with no overweight unit the shortfalls sum to the
    // deposit exactly, so each unit receives precisely what it needs.
    const holdings = {
      us_equity: 450_000,
      cad_bonds: 100_000,
      cad_equity: 200_000,
      intl_equity: 150_000,
      em_equity: 100_000,
    };
    const deposit = 1_000_000;
    const plan = planDeposit(units(holdings), roomy, deposit);
    const total = Object.values(holdings).reduce((a, b) => a + b, 0) + deposit;

    for (const line of plan.lines) {
      const before = holdings[line.assetId as keyof typeof holdings];
      const targetWeight = units().find((u) => u.id === line.assetId)!.targetWeight;
      expect(before + line.amountCents).toBe((total * targetWeight) / 100_000_000);
    }
    expect(plan.unallocatedCents).toBe(0);
  });
});
