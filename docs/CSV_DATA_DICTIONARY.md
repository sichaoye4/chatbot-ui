# CSV data dictionary and computation policy

Source: `sample_data/training_data_masked_final_1.csv`; hash and independent expected results are frozen in `tests/oracles/csv-expected.json`.

| Fields | Parsing | Interpretation / restrictions |
|---|---|---|
| `domain`, `system`, `ctry_iso_cde` | Required exact strings | Filter dimensions; do not infer tenant ownership |
| `srce_team_base`, `src_infra_tech`, `src_devops` | Required exact strings | Preserve spelling and case, including Linux/linux |
| `src_tier` | Required number | Raw tier code; no averaging or categorical business interpretation registered |
| `src_team_size`, `src_chg`, `src_inc`, `n_middle_syst` | Required numbers | Raw source values; additive grain not established |
| `src_ctrl_score` | Required number | Raw score; business definition unconfirmed |
| `xfer_team_base` | Nullable string | Blank remains null |
| `xfer_team_size`, `xfer_chg`, `xfer_inc` | Nullable numbers | 189 missing values each; never substitute zero |
| `data_team_base` | Nullable string | Blank remains null |
| `data_proc_team_type` | Required exact string | Raw category |
| `data_team_size`, `data_syst_inc`, `data_syst_chg` | Nullable numbers | 120 missing values each; additive grain unconfirmed |
| `month_id` | Required YYYYMM string | Validated calendar month; analytics expose YYYY-MM |
| `data_ctrl_score`, `avg_comp` | Required numbers | User-requested quality measures; display separately as unweighted means on raw recorded scales. Do not invent a normalized score or combine them. |
| `sla_met_rate` | Required finite ratio in [0,1] | Unweighted mean permitted; no weighted SLA or breach-count computation |
| `rowId` (derived) | Source hash + parsed-record ordinal | Unique within immutable source; candidate business keys are not unique |

The repository validates headers, record widths, nullability, numeric syntax, month syntax and ratio range. Canonical startup also checks the exact source hash. It preserves all 3,509 rows and fails readiness if the source changes unexpectedly.

Registered measures: source-record count, distinct-system count, arithmetic mean of `sla_met_rate`, SLA observation count, and missing transfer-team-size count. A zero-row query is a successful empty result; its mean is null. Mean output includes its record count. Display percentages are rounded to two decimals; calculations use numeric ratios. Independent tests compare against Python Decimal with absolute tolerance 1e-12.

User clarification (2026-11-14): an unspecified **data quality** request shows all three recorded measures: `avg_comp`, `data_ctrl_score`, and `sla_met_rate`. `csv.monthlyQuality` supplies separate monthly means and observation counts; the first two stay on raw numeric scales, while SLA is a ratio displayed as a percentage. An explicitly named measure produces only that measure's trend. Independent payment/2024 Decimal goldens were added without changing the previous expectations.

Question scope and UI controls are different: “payment in 2024” sets fixed binding arguments (`domain=payment`, `startMonth=2024-01`, `endMonth=2024-12`); it does not request a domain/year dropdown. Interactive select controls are declared only for dimensions requested by the user, and their options are resolved server-side within the remaining fixed scope and authorization. Supported select dimensions are domain, country, system, and month. A date-range/year control is not implemented; dates remain fixed query arguments unless a supported month selector is requested.

Monthly results insert null buckets between explicitly requested month bounds (or first/last observed month), so chart lines do not bridge missing months. An entirely empty cohort returns no fabricated observations. Table pagination orders by an allowlisted field with parsed-record ordinal as the stable tiebreaker. Cursor signatures bind source, principal, scope, filters, sorting, columns and page size; process restart can invalidate an old next-page cursor, but refresh starts a new page safely.

Demo identity is a server policy, not CSV metadata. A retained conversation stores its original domain scope and becomes inaccessible when the current principal loses any of that scope, including historical explanatory text.
