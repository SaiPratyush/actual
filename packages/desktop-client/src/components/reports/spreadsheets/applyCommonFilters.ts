import { type QueryDataEntity } from '@desktop-client/components/reports/ReportOptions';

export function applyCommonFilters(
  data: QueryDataEntity[],
  showOffBudget?: boolean,
  showHiddenCategories?: boolean,
  showUncategorized?: boolean,
): QueryDataEntity[] {
  return data
    .filter(
      e =>
        showHiddenCategories ||
        (e.categoryHidden === false && e.categoryGroupHidden === false),
    )
    .filter(e => showOffBudget || e.accountOffBudget === false)
    .filter(
      e =>
        showUncategorized || e.category !== null || e.accountOffBudget === true,
    );
}
