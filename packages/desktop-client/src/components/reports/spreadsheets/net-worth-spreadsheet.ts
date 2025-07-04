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
  firstDayOfWeekIdx: string = '0',
) {
  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: ReturnType<typeof recalculate>) => void,
  ) => {
    const { filters } = await send('make-filters-from-conditions', {
      conditions: conditions.filter(cond => !cond.customName),
    });
    const conditionsOpKey = conditionsOp === 'or' ? '$or' : '$and';

    // Handle different intervals following the pattern from other reports
    const isDaily = interval === 'Daily';
    const isWeekly = interval === 'Weekly';
    const isYearly = interval === 'Yearly';
    
    // Always convert to full date format for database queries
    const startDate = monthUtils.firstDayOfMonth(start);
    const endDate = monthUtils.lastDayOfMonth(end);

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
                // For weekly, use daily grouping and transform later (like other reports)
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

        // Handle Weekly interval by transforming dates (same pattern as other reports)
        const transformedBalances = isWeekly 
          ? balances.map(b => ({
              ...b,
              date: monthUtils.weekFromDate(b.date, firstDayOfWeekIdx),
            }))
          : balances;

        return {
          id: acct.id,
          balances: keyBy(transformedBalances, 'date'),
          starting,
        };
      }),
    );

    setData(recalculate(data, startDate, endDate, locale, interval, firstDayOfWeekIdx));
  };
}

// Helper function to get the correct date ranges based on interval
function getDateRanges(start: string, end: string, interval: string, firstDayOfWeekIdx: string) {
  switch (interval) {
    case 'Daily':
      return monthUtils.dayRangeInclusive(start, end);
    case 'Weekly':
      return monthUtils.weekRangeInclusive(start, end, firstDayOfWeekIdx);
    case 'Yearly':
      return monthUtils.yearRangeInclusive(start, end);
    case 'Monthly':
    default:
      // For monthly, convert back to month format
      return monthUtils.rangeInclusive(
        monthUtils.getMonth(start), 
        monthUtils.getMonth(end)
      );
  }
}

// Helper function to apply smoothing to data for high-frequency intervals
function applySmoothingToData(
  data: Array<{
    x: string;
    y: number;
    assets: string;
    debt: string;
    change: string;
    networth: string;
    date: string;
  }>,
  interval: string,
  windowSize: number = 7, // Default 7-day moving average
) {
  if (interval !== 'Daily' && interval !== 'Weekly') {
    return data; // No smoothing for monthly/yearly
  }

  if (data.length <= windowSize) {
    return data; // Not enough data points for smoothing
  }

  return data.map((item, index) => {
    // For smoothing, we only smooth the y value (net worth), keep other fields as-is
    const startIndex = Math.max(0, index - Math.floor(windowSize / 2));
    const endIndex = Math.min(data.length - 1, index + Math.floor(windowSize / 2));
    
    let sum = 0;
    let count = 0;
    
    for (let i = startIndex; i <= endIndex; i++) {
      sum += data[i].y;
      count++;
    }
    
    const smoothedValue = sum / count;
    
    return {
      ...item,
      y: smoothedValue,
      networth: integerToCurrency(amountToInteger(smoothedValue)),
    };
  });
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
  firstDayOfWeekIdx: string = '0',
) {
  // Get the correct date intervals
  const intervals = getDateRanges(start, end, interval, firstDayOfWeekIdx);

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

  // Apply smoothing to daily and weekly data
  const smoothedData = applySmoothingToData(graphData, interval);

  return {
    graphData: {
      data: smoothedData,
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
