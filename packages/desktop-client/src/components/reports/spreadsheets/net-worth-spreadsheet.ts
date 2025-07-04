import * as d from 'date-fns';
import { type Locale } from 'date-fns';
import keyBy from 'lodash/keyBy';

import { send } from 'loot-core/platform/client/fetch';
import * as monthUtils from 'loot-core/shared/months';
import { q } from 'loot-core/shared/query';
import {
  integerToCurrency,
  integerToAmount,
  amountToInteger,
} from 'loot-core/shared/util';
import {
  type AccountEntity,
  type RuleConditionEntity,
} from 'loot-core/types/models';

import { type useSpreadsheet } from '@desktop-client/hooks/useSpreadsheet';
import { aqlQuery } from '@desktop-client/queries/aqlQuery';

type Balance = {
  date: string;
  amount: number;
};

export function createSpreadsheet(
  start: string,
  end: string,
  accounts: AccountEntity[],
  conditions: RuleConditionEntity[] = [],
  conditionsOp: 'and' | 'or' = 'and',
  locale: Locale,
  interval: string = 'Monthly',
) {
  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: ReturnType<typeof recalculate>) => void,
  ) => {
    const { filters } = await send('make-filters-from-conditions', {
      conditions: conditions.filter(cond => !cond.customName),
    });
    const conditionsOpKey = conditionsOp === 'or' ? '$or' : '$and';

    // Handle different intervals like cash flow does - simpler approach
    const isDaily = interval === 'Daily';
    const isWeekly = interval === 'Weekly';
    const isYearly = interval === 'Yearly';
    
    // For daily and weekly, we need to work with actual dates, not month transforms
    const startDate = isDaily || isWeekly ? start : monthUtils.firstDayOfMonth(start);
    const endDate = isDaily || isWeekly ? end : monthUtils.lastDayOfMonth(end);

    const data = await Promise.all(
      accounts.map(async acct => {
        const [starting, balances]: [number, Balance[]] = await Promise.all([
          aqlQuery(
            q('transactions')
              .filter({
                [conditionsOpKey]: filters,
                account: acct.id,
                date: { $lt: startDate },
              })
              .calculate({ $sum: '$amount' }),
          ).then(({ data }) => data),

          aqlQuery(
            q('transactions')
              .filter({
                [conditionsOpKey]: filters,
              })
              .filter({
                account: acct.id,
                $and: [
                  { date: { $gte: startDate } },
                  { date: { $lte: endDate } },
                ],
              })
              .groupBy(
                isDaily || isWeekly ? 'date' :
                isYearly ? { $year: '$date' } :
                { $month: '$date' }
              )
              .select([
                { 
                  date: isDaily || isWeekly ? 'date' :
                        isYearly ? { $year: '$date' } :
                        { $month: '$date' }
                },
                { amount: { $sum: '$amount' } },
              ]),
          ).then(({ data }) => data),
        ]);

        // Handle Weekly interval by transforming dates
        const transformedBalances = isWeekly 
          ? balances.map(b => ({
              ...b,
              date: monthUtils.weekFromDate(b.date, '0'),
            }))
          : balances;

        return {
          id: acct.id,
          balances: keyBy(transformedBalances, 'date'),
          starting,
        };
      }),
    );

    setData(recalculate(data, start, end, locale, interval));
  };
}

// Helper function to get the correct date ranges based on interval
function getDateRanges(start: string, end: string, interval: string) {
  switch (interval) {
    case 'Daily':
      return monthUtils.dayRangeInclusive(start, end);
    case 'Weekly':
      return monthUtils.weekRangeInclusive(start, end, '0');
    case 'Yearly':
      return monthUtils.yearRangeInclusive(start, end);
    case 'Monthly':
    default:
      return monthUtils.rangeInclusive(start, end);
  }
}



function recalculate(
  data: Array<{
    id: string;
    balances: Record<string, Balance>;
    starting: number;
  }>,
  start: string,
  end: string,
  locale: Locale,
  interval: string = 'Monthly',
) {
  // Get the correct date intervals
  const intervals = getDateRanges(start, end, interval);

  const accountBalances = data.map(account => {
    // Start off with the balance at that point in time
    let balance = account.starting;
    return intervals.map(intervalItem => {
      if (account.balances[intervalItem]) {
        balance += account.balances[intervalItem].amount;
      }
      return balance;
    });
  });

  let hasNegative = false;
  let startNetWorth = 0;
  let endNetWorth = 0;
  let lowestNetWorth: number | null = null;
  let highestNetWorth: number | null = null;

  const graphData = intervals.reduce<
    Array<{
      x: string;
      y: number;
      assets: string;
      debt: string;
      change: string;
      networth: string;
      date: string;
    }>
  >((arr, intervalItem, idx) => {
    let debt = 0;
    let assets = 0;
    let total = 0;
    const last = arr.length === 0 ? null : arr[arr.length - 1];

    accountBalances.forEach(balances => {
      const balance = balances[idx];
      if (balance < 0) {
        debt += -balance;
      } else {
        assets += balance;
      }
      total += balance;
    });

    if (total < 0) {
      hasNegative = true;
    }

    // Parse dates correctly based on interval type
    const x = interval === 'Daily' || interval === 'Weekly' 
      ? d.parseISO(intervalItem)
      : interval === 'Yearly'
      ? d.parseISO(intervalItem + '-01-01')
      : d.parseISO(intervalItem + '-01');
    const change = last ? total - amountToInteger(last.y) : 0;

    if (arr.length === 0) {
      startNetWorth = total;
    }
    endNetWorth = total;

    const displayFormat = 
      interval === 'Daily' ? 'MM/dd' :
      interval === 'Weekly' ? 'MM/dd' :
      interval === 'Yearly' ? 'yyyy' :
      "MMM ''yy"; // Monthly default

    const tooltipFormat = 
      interval === 'Daily' ? 'MMMM d, yyyy' :
      interval === 'Weekly' ? 'MMM d, yyyy' :
      interval === 'Yearly' ? 'yyyy' :
      'MMMM yyyy'; // Monthly default

    arr.push({
      x: d.format(x, displayFormat, { locale }),
      y: integerToAmount(total),
      assets: integerToCurrency(assets),
      debt: `-${integerToCurrency(debt)}`,
      change: integerToCurrency(change),
      networth: integerToCurrency(total),
      date: d.format(x, tooltipFormat, { locale }),
    });

    arr.forEach(item => {
      if (lowestNetWorth === null || item.y < lowestNetWorth) {
        lowestNetWorth = item.y;
      }
      if (highestNetWorth === null || item.y > highestNetWorth) {
        highestNetWorth = item.y;
      }
    });
    return arr;
  }, []);

  return {
    graphData: {
      data: graphData,
      hasNegative,
      start,
      end,
    },
    netWorth: endNetWorth,
    totalChange: endNetWorth - startNetWorth,
    lowestNetWorth,
    highestNetWorth,
  };
}
