"""Independent decimal oracle. --verify never rewrites reviewed expectations."""
import argparse
import csv
import hashlib
import json
from collections import Counter, defaultdict
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'sample_data/training_data_masked_final_1.csv'
EXPECTED = Path(__file__).with_name('csv-expected.json')
HASH = '56fc638633ab77d75cdefb79ae988aca783c21070b96493bacca61f89f28842a'


def summarize(rows):
    rates = [Decimal(row['sla_met_rate']) for row in rows if row['sla_met_rate']]
    return {
        'record_count': len(rows),
        'distinct_systems': len({row['system'] for row in rows}),
        'sla_mean': str(sum(rates) / len(rates)) if rates else None,
        'sla_observations': len(rates),
        'missing_transfer_size': sum(row['xfer_team_size'] == '' for row in rows),
    }


def monthly(rows):
    groups = defaultdict(list)
    for row in rows:
        groups[row['month_id']].append(row)
    return [{'month': month[:4] + '-' + month[4:], **summarize(values)}
            for month, values in sorted(groups.items())]


def build():
    assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == HASH, 'Source hash changed: review required'
    with SOURCE.open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        rows = list(reader)
        columns = reader.fieldnames
    assert len(rows) == 3509 and len(columns) == 25
    for row in rows:
        assert len(row['month_id']) == 6 and 1 <= int(row['month_id'][4:]) <= 12
        assert Decimal(0) <= Decimal(row['sla_met_rate']) <= Decimal(1)
    keys = Counter(tuple(row[key] for key in ['domain', 'system', 'ctry_iso_cde', 'month_id']) for row in rows)
    kyc = [row for row in rows if row['domain'] == 'kyc']
    selected = [row for row in kyc if row['system'] == 'DSU' and row['ctry_iso_cde'] == 'AE']
    return {
        'sourceHash': HASH, 'columns': columns,
        'profile': {'rows': len(rows), 'nulls': {key: sum(row[key] == '' for row in rows) for key in columns},
                    'candidateKeyExcessRows': sum(value - 1 for value in keys.values()),
                    'months': sorted({row['month_id'] for row in rows}),
                    'countries': len({row['ctry_iso_cde'] for row in rows})},
        'all': summarize(rows), 'kyc': summarize(kyc),
        'domainCounts': dict(sorted(Counter(row['domain'] for row in rows).items())),
        'monthly': monthly(rows), 'kycMonthly': monthly(kyc),
        'paymentQuality2024': [{
            'month': month[:4] + '-' + month[4:],
            **{field: str(sum(Decimal(row[field]) for row in rows if row['domain'] == 'payment' and row['month_id'] == month) / sum(row['domain'] == 'payment' and row['month_id'] == month for row in rows)) for field in ['avg_comp', 'data_ctrl_score', 'sla_met_rate']}
        } for month in sorted({row['month_id'] for row in rows if row['month_id'].startswith('2024')})],
        'selected': summarize(selected), 'selectedMonthly': monthly(selected),
        'kycFirstPage': [row for row in kyc][:50],
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    result = build()
    if args.verify:
        assert json.loads(EXPECTED.read_text(encoding='utf-8')) == result, 'Golden mismatch: review required'
        print('CSV oracle verified: hash, 3509 rows, nulls, repeated keys, all/filtered aggregates and months.')
    else:
        EXPECTED.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
        print('Wrote candidate expectations. Review before accepting.')
