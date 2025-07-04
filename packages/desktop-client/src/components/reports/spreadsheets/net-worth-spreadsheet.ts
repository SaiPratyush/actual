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

    const data = await Promise.all(
      accounts.map(async acct => {
        const [starting, balances]: [number, Balance[]] = await Promise.all([
          aqlQuery(
            q('transactions')
              .filter({
                [conditionsOpKey]: filters,
                account: acct.id,
                date: { $lt: getIntervalStartDate(start, interval) },
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
                  { date: { $gte: getIntervalStartDate(start, interval) } },
                  { date: { $lte: getIntervalEndDate(end, interval) } },
                ],
              })
              .groupBy(getGroupByExpression(interval))
              .select([
                { date: getGroupByExpression(interval) },
                { amount: { $sum: '$amount' } },
              ]),
          ).then(({ data }) => data),
        ]);

        return {
          id: acct.id,
          balances: keyBy(balances, 'date'),
          starting,
        };
      }),
    );

    setData(recalculate(data, start, end, locale, interval));
  };
}

function getGroupByExpression(interval: string) {
  switch (interval) {
    case 'Daily':
      return { $day: '$date' }; // This groups by full date: YYYY-MM-DD
    case 'Weekly':
      return { $week: '$date' };
    case 'Yearly':
      return { $year: '$date' };
    case 'Monthly':
    default:
      return { $month: '$date' };
  }
}

function getIntervalStartDate(date: string, interval: string): string {
  switch (interval) {
    case 'Daily':
      return date; // For daily, use the exact date
    case 'Weekly':
      return monthUtils.weekFromDate(date, '0'); // Start of week
    case 'Yearly':
      return monthUtils.getYearStart(date);
    case 'Monthly':
    default:
      return monthUtils.firstDayOfMonth(date);
  }
}

function getIntervalEndDate(date: string, interval: string): string {
  switch (interval) {
    case 'Daily':
      return date; // For daily, use the exact date
    case 'Weekly':
      return monthUtils.getWeekEnd(date, '0'); // End of week
    case 'Yearly':
      return monthUtils.getYearEnd(date);
    case 'Monthly':
    default:
      return monthUtils.lastDayOfMonth(date);
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
  const intervals = getIntervalRange(start, end, interval);

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

    const x = parseIntervalDate(intervalItem, interval);
    const change = last ? total - amountToInteger(last.y) : 0;

    if (arr.length === 0) {
      startNetWorth = total;
    }
    endNetWorth = total;

    arr.push({
      x: formatIntervalForDisplay(x, interval, locale),
      y: integerToAmount(total),
      assets: integerToCurrency(assets),
      debt: `-${integerToCurrency(debt)}`,
      change: integerToCurrency(change),
      networth: integerToCurrency(total),
      date: formatIntervalForTooltip(x, interval, locale),
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

function getIntervalRange(start: string, end: string, interval: string): string[] {
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

function parseIntervalDate(intervalItem: string, interval: string): Date {
  switch (interval) {
    case 'Daily':
      return d.parseISO(intervalItem);
    case 'Weekly':
      return d.parseISO(intervalItem);
    case 'Yearly':
      return d.parseISO(intervalItem + '-01-01');
    case 'Monthly':
    default:
      return d.parseISO(intervalItem + '-01');
  }
}

function formatIntervalForDisplay(date: Date, interval: string, locale: Locale): string {
  switch (interval) {
    case 'Daily':
      return d.format(date, 'MM/dd', { locale });
    case 'Weekly':
      return d.format(date, 'MM/dd', { locale });
    case 'Yearly':
      return d.format(date, 'yyyy', { locale });
    case 'Monthly':
    default:
      return d.format(date, "MMM ''yy", { locale });
  }
}

function formatIntervalForTooltip(date: Date, interval: string, locale: Locale): string {
  switch (interval) {
    case 'Daily':
      return d.format(date, 'MMMM d, yyyy', { locale });
    case 'Weekly':
      return d.format(date, 'MMM d, yyyy', { locale });
    case 'Yearly':
      return d.format(date, 'yyyy', { locale });
    case 'Monthly':
    default:
      return d.format(date, 'MMMM yyyy', { locale });
  }
}
