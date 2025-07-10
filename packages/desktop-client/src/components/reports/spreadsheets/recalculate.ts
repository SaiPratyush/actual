import * as monthUtils from 'loot-core/shared/months';
import { amountToInteger, integerToAmount } from 'loot-core/shared/util';
import {
  type GroupedEntity,
  type IntervalEntity,
} from 'loot-core/types/models';

// NOTE: This file now works with pre-built indexes; filtering is done once
// upstream (see `applyCommonFilters`) and we no longer call `filterHiddenItems`
// here.

import { type UncategorizedEntity } from '@desktop-client/components/reports/ReportOptions';

type recalculateProps = {
  item: UncategorizedEntity;
  intervals: Array<string>;
  assetIndex: Map<string, number>;
  debtIndex: Map<string, number>;
  groupByLabel: 'category' | 'categoryGroup' | 'payee' | 'account';
  startDate: string;
  endDate: string;
};

export function recalculate({
  item,
  intervals,
  assetIndex,
  debtIndex,
  groupByLabel,
  startDate,
  endDate,
}: recalculateProps): GroupedEntity {
  let totalAssets = 0;
  let totalDebts = 0;

  const groupsByCategory =
    groupByLabel === 'category' || groupByLabel === 'categoryGroup';

  // Resolve the lookup key once per item
  const itemKey =
    groupsByCategory && item.uncategorized_id
      ? item.uncategorized_id
      : (item.id ?? null);

  const intervalData = intervals.reduce(
    (arr: IntervalEntity[], intervalItem, index) => {
      const last = arr.length === 0 ? null : arr[arr.length - 1];

      const intervalAssets = assetIndex.get(`${intervalItem}|${itemKey}`) ?? 0;
      const intervalDebts = debtIndex.get(`${intervalItem}|${itemKey}`) ?? 0;

      totalAssets += intervalAssets;
      totalDebts += intervalDebts;

      const intervalTotals = intervalAssets + intervalDebts;

      const change = last
        ? intervalTotals - amountToInteger(last.totalTotals)
        : 0;

      arr.push({
        totalAssets: integerToAmount(intervalAssets),
        totalDebts: integerToAmount(intervalDebts),
        netAssets: intervalTotals > 0 ? integerToAmount(intervalTotals) : 0,
        netDebts: intervalTotals < 0 ? integerToAmount(intervalTotals) : 0,
        totalTotals: integerToAmount(intervalTotals),
        change,
        intervalStartDate: index === 0 ? startDate : intervalItem,
        intervalEndDate:
          index + 1 === intervals.length
            ? endDate
            : monthUtils.subDays(intervals[index + 1], 1),
      });

      return arr;
    },
    [],
  );

  const totalTotals = totalAssets + totalDebts;

  return {
    id: item.id || '',
    name: item.name,
    totalAssets: integerToAmount(totalAssets),
    totalDebts: integerToAmount(totalDebts),
    netAssets: totalTotals > 0 ? integerToAmount(totalTotals) : 0,
    netDebts: totalTotals < 0 ? integerToAmount(totalTotals) : 0,
    totalTotals: integerToAmount(totalTotals),
    intervalData,
  };
}
