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
import { ReportOptions } from '@desktop-client/components/reports/ReportOptions';

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

    // Use the same pattern as custom reports for interval handling
    const intervalGroup = getGroupByExpression(interval);
    const intervalFilter = getIntervalFilter(interval);

    const data = await Promise.all(
      accounts.map(async acct => {
        const [starting, balances]: [number, Balance[]] = await Promise.all([
          aqlQuery(
            q('transactions')
              .filter({
                [conditionsOpKey]: filters,
                account: acct.id,
                date: { $transform: intervalFilter, $lt: start },
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
                  { date: { $transform: intervalFilter, $gte: start } },
                  { date: { $transform: intervalFilter, $lte: end } },
                ],
              })
              .groupBy(intervalGroup)
              .select([
                { date: intervalGroup },
                { amount: { $sum: '$amount' } },
              ]),
          ).then(({ data }) => data),
        ]);

        // Handle Weekly interval by transforming dates like custom reports do
        const transformedBalances = interval === 'Weekly' 
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

function getGroupByExpression(interval: string) {
  const intervalGroup =
    interval === 'Monthly'
      ? { $month: '$date' }
      : interval === 'Yearly'
        ? { $year: '$date' }
        : { $day: '$date' };
  return intervalGroup;
}

function getIntervalFilter(interval: string) {
  const intervalFilter =
    interval === 'Weekly'
      ? '$day'
      : '$' + (ReportOptions.intervalMap.get(interval)?.toLowerCase() || 'month');
  return intervalFilter;
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
  // Use the same interval range logic as custom reports
  const intervals =
    interval === 'Weekly'
      ? monthUtils.weekRangeInclusive(start, end, '0')
      : monthUtils[
          ReportOptions.intervalRange.get(interval) || 'rangeInclusive'
        ](start, end);

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

    const x = d.parseISO(
      interval === 'Yearly' ? intervalItem + '-01-01' :
      interval === 'Daily' ? intervalItem :
      intervalItem + '-01'
    );
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
