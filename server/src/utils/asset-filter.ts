import { Expression, SelectQueryBuilder, SqlBool, expressionBuilder } from 'kysely';
import { DB } from 'src/schema/index.js';
import { without } from 'src/utils/filter-suggestions.js';

/**
 * The filter panel's shared vocabulary, defined once for every fork surface that answers it: the
 * timeline buckets, filter suggestions, smart-search facets, the filtered map and the space people
 * lists. Viewer scope (owner / space / visibility) is NOT part of it; each caller keeps its own.
 *
 * - taken: `asset.localDateTime`, the column the timeline groups its buckets by, so a month the panel
 *   sends is the same month the grid shows. `takenAfter` is inclusive, `takenBefore` exclusive,
 *   because the panel sends the start of the next day/month as the upper bound.
 * - place/camera: `null` means "has no value" (IS NULL), `undefined` and `''` mean "no filter".
 * - rating: a minimum (`>=`); `null` means unrated.
 *
 * Upstream search (`searchAssetBuilderLegacy`) keeps its own rules (`fileCreatedAt`, inclusive upper
 * bound, exact rating unless `ratingIsMinimum`); see specs/2026-07-23-search-v3-coexistence-design.md.
 */
export interface AssetFilter {
  takenAfter?: Date | string;
  takenBefore?: Date | string;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  make?: string | null;
  model?: string | null;
  lensModel?: string | null;
  rating?: number | null;
}

export const assetFilterKeys = [
  'takenAfter',
  'takenBefore',
  'country',
  'state',
  'city',
  'make',
  'model',
  'lensModel',
  'rating',
] as const satisfies (keyof AssetFilter)[];

const exifColumns = ['country', 'state', 'city', 'make', 'model', 'lensModel'] as const;

/** One condition per active filter, minus the `exclude`d keys (a facet listing its own values). */
export function assetFilterConditions(
  filter: AssetFilter,
  exclude: readonly (keyof AssetFilter)[] = [],
): Expression<SqlBool>[] {
  const f = without(filter, ...exclude);
  const eb = expressionBuilder<DB, 'asset'>();
  const conditions: Expression<SqlBool>[] = [];
  if (f.takenAfter) {
    conditions.push(eb('asset.localDateTime', '>=', new Date(f.takenAfter)));
  }
  if (f.takenBefore) {
    conditions.push(eb('asset.localDateTime', '<', new Date(f.takenBefore)));
  }

  const exif = exifColumns.filter((column) => f[column] !== undefined && f[column] !== '');
  if (exif.length > 0 || f.rating !== undefined) {
    conditions.push(
      eb.exists(
        eb
          .selectFrom('asset_exif')
          .whereRef('asset_exif.assetId', '=', 'asset.id')
          .where((eb) =>
            eb.and([
              ...exif.map((column) => eb(`asset_exif.${column}`, f[column] === null ? 'is' : '=', f[column]!)),
              ...(f.rating === undefined ? [] : [eb('asset_exif.rating', f.rating === null ? 'is' : '>=', f.rating)]),
            ]),
          ),
      ),
    );
  }

  return conditions;
}

/** Applies {@link assetFilterConditions} to a query that has `asset` in scope. */
export function withAssetFilter<T extends SelectQueryBuilder<DB, any, any>>(
  qb: T,
  filter: AssetFilter,
  exclude?: readonly (keyof AssetFilter)[],
): T {
  let query: SelectQueryBuilder<DB, any, any> = qb;
  for (const condition of assetFilterConditions(filter, exclude)) {
    query = query.where(condition);
  }
  return query as T;
}
