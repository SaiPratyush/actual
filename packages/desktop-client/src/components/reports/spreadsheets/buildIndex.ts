import { type QueryDataEntity } from '@desktop-client/components/reports/ReportOptions';

/**
 * Build an index for quick O(1) look-ups of the summed amount per
 * (interval/date, groupKey).
 *
 * The `groupByLabel` determines which property on the query row is used for
 * the "regular" key.  If we are grouping by category or categoryGroup we also
 * need to support the special "uncategorised" buckets (off_budget, transfer,
 * other, all).
 */
export function buildIndex(
  rows: QueryDataEntity[],
  groupByLabel: 'category' | 'categoryGroup' | 'payee' | 'account',
  groupsByCategory: boolean,
): Map<string, number> {
  const index = new Map<string, number>();

  function add(date: string, key: string | null, amount: number) {
    const composite = `${date}|${key ?? 'null'}`;
    index.set(composite, (index.get(composite) ?? 0) + amount);
  }

  rows.forEach(row => {
    // Primary key (category id, categoryGroup id, payee id, account id…)
    const baseKey = (row as any)[groupByLabel] ?? null;
    add(row.date, baseKey, row.amount);

    if (groupsByCategory) {
      // Additional synthetic keys for the uncategorised buckets
      // Note: These follow the logic in `filterHiddenItems` for category
      // grouping.
      const hasCategory = !!row.category;
      const isOffBudget = row.accountOffBudget;
      const isTransfer = !!row.transferAccount;

      if (!hasCategory || isOffBudget) {
        // Add to the 'all' bucket representing uncategorised & off-budget
        add(row.date, 'all', row.amount);
        if (isOffBudget) {
          add(row.date, 'off_budget', row.amount);
        } else if (isTransfer) {
          add(row.date, 'transfer', row.amount);
        } else {
          add(row.date, 'other', row.amount);
        }
      }
    }
  });

  return index;
}
