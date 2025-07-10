import { type QueryDataEntity } from '@desktop-client/components/reports/ReportOptions';

export function buildDateIndex(rows: QueryDataEntity[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const r of rows) {
    index.set(r.date, (index.get(r.date) ?? 0) + r.amount);
  }
  return index;
}
