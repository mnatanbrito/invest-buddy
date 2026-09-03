import type { Executor } from '../db/pool';
import { accounts, assets, sleeves } from '../db/schema';

export interface PresetAsset {
  id: string;
  ticker: string;
  label: string;
  weightBps: number;
}

export interface PresetSleeve {
  id: string;
  label: string;
  targetBps: number;
  assets: PresetAsset[];
}

export interface PresetAccount {
  id: string;
  label: string;
  note: string;
  roomLimitCents: number | null;
  sleeves: PresetSleeve[];
}

/** The original hardcoded 55/35/10 portfolio, now an opt-in preset rather than a forced seed. */
export const EXAMPLE_PORTFOLIO: PresetAccount[] = [
  {
    id: 'rrsp',
    label: 'RRSP',
    note: 'US-listed direct, no withholding tax',
    roomLimitCents: 5_000_000,
    sleeves: [
      {
        id: 'us_equity',
        label: 'US total market',
        targetBps: 4500,
        assets: [{ id: 'us_equity_vti', ticker: 'VTI', label: '', weightBps: 10_000 }],
      },
      {
        id: 'cad_bonds',
        label: 'Canadian bonds',
        targetBps: 1000,
        assets: [{ id: 'cad_bonds_vab', ticker: 'VAB', label: '', weightBps: 10_000 }],
      },
    ],
  },
  {
    id: 'tfsa',
    label: 'TFSA',
    note: 'Highest-growth assets, tax-free forever',
    roomLimitCents: 2_500_000,
    sleeves: [
      {
        id: 'cad_equity',
        label: 'Canadian equity',
        targetBps: 2000,
        assets: [{ id: 'cad_equity_vcn', ticker: 'VCN', label: '', weightBps: 10_000 }],
      },
      {
        id: 'intl_equity',
        label: 'International EAFE',
        targetBps: 1500,
        assets: [{ id: 'intl_equity_xef', ticker: 'XEF', label: '', weightBps: 10_000 }],
      },
    ],
  },
  {
    id: 'non_registered',
    label: 'Non-registered',
    note: 'Overflow once RRSP and TFSA are maxed',
    roomLimitCents: null,
    sleeves: [
      {
        id: 'em_equity',
        label: 'Emerging markets',
        targetBps: 1000,
        assets: [{ id: 'em_equity_vee', ticker: 'VEE', label: '', weightBps: 10_000 }],
      },
    ],
  },
];

/** Assumes an empty database — callers must enforce that before inserting. */
export async function insertPortfolio(exec: Executor, accountsInput: PresetAccount[]): Promise<void> {
  let accountSortOrder = 1;
  for (const account of accountsInput) {
    await exec.insert(accounts).values({
      id: account.id,
      label: account.label,
      note: account.note,
      roomLimit: account.roomLimitCents,
      sortOrder: accountSortOrder++,
    });

    let sleeveSortOrder = 1;
    for (const sleeve of account.sleeves) {
      await exec.insert(sleeves).values({
        id: sleeve.id,
        accountId: account.id,
        label: sleeve.label,
        targetBps: sleeve.targetBps,
        sortOrder: sleeveSortOrder++,
      });

      let assetSortOrder = 1;
      for (const asset of sleeve.assets) {
        await exec.insert(assets).values({
          id: asset.id,
          sleeveId: sleeve.id,
          ticker: asset.ticker,
          label: asset.label,
          weightBps: asset.weightBps,
          sortOrder: assetSortOrder++,
        });
      }
    }
  }
}
