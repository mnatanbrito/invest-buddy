-- Seeds the account/sleeve structure from the target allocation diagram.
-- Safe to re-run: accounts and sleeves upsert, holdings are left untouched.

INSERT INTO accounts (id, label, note, room_limit, sort_order) VALUES
  ('rrsp',           'RRSP',           'US-listed direct, no withholding tax',   5000000, 1),
  ('tfsa',           'TFSA',           'Highest-growth assets, tax-free forever', 2500000, 2),
  ('non_registered', 'Non-registered', 'Overflow once RRSP and TFSA are maxed',      NULL, 3)
ON CONFLICT (id) DO UPDATE
  SET label = EXCLUDED.label, note = EXCLUDED.note, sort_order = EXCLUDED.sort_order;

-- target_bps are basis points of the TOTAL portfolio and sum to 10000.
INSERT INTO sleeves (id, account_id, tickers, label, target_bps, sort_order) VALUES
  ('us_equity',   'rrsp',           'VTI or ITOT', 'US total market',      4500, 1),
  ('cad_bonds',   'rrsp',           'VAB or XBB',  'Canadian bonds',       1000, 2),
  ('cad_equity',  'tfsa',           'VCN or XIC',  'Canadian equity',      2000, 3),
  ('intl_equity', 'tfsa',           'XEF or VIU',  'International EAFE',   1500, 4),
  ('em_equity',   'non_registered', 'VEE or XEC',  'Emerging markets',     1000, 5)
ON CONFLICT (id) DO UPDATE
  SET account_id = EXCLUDED.account_id, tickers = EXCLUDED.tickers,
      label = EXCLUDED.label, target_bps = EXCLUDED.target_bps,
      sort_order = EXCLUDED.sort_order;

DO $$
DECLARE total INT;
BEGIN
  SELECT SUM(target_bps) INTO total FROM sleeves;
  IF total <> 10000 THEN
    RAISE EXCEPTION 'sleeve target_bps must sum to 10000, got %', total;
  END IF;
END $$;
