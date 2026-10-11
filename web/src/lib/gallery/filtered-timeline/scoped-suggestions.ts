import { AssetTypeEnum, getFilterSuggestions, getSearchSuggestions, SearchSuggestionType } from '@immich/sdk';
import {
  ALL_FILTER_SECTIONS,
  buildFilterContext,
  createFilterState,
  type FilterContext,
  type FilterPanelConfig,
  type FilterState,
} from '$lib/components/filter-panel/filter-panel';
import { getPhotosPersonFilterId, getPhotosPersonFilterThumbnailUrl } from '$lib/utils/photos-filter-options';

/** A browse scope wider than my own assets: the spaces I show on my timeline, or one space. */
export type SuggestionScope = { withSharedSpaces: true } | { spaceId: string };

/** Browse-mode panel suggestions for a scope; inside a space, people are keyed by their own id. */
export const loadScopedSuggestions = async (filters: FilterState, scope: SuggestionScope) => {
  const context = buildFilterContext(filters);
  const response = await getFilterSuggestions({
    personIds: filters.personIds.length > 0 ? filters.personIds : undefined,
    country: filters.country,
    state: filters.state,
    city: filters.city,
    make: filters.make,
    model: filters.model,
    lensModel: filters.lensModel,
    ownerId: filters.ownerId,
    tagIds: filters.tagIds.length > 0 ? filters.tagIds : undefined,
    rating: filters.rating,
    mediaType:
      filters.mediaType === 'all'
        ? undefined
        : filters.mediaType === 'image'
          ? AssetTypeEnum.Image
          : AssetTypeEnum.Video,
    isFavorite: filters.isFavorite,
    isNotInAlbum: filters.isNotInAlbum === true ? true : undefined,
    isInAlbum: filters.isInAlbum === true ? true : undefined,
    takenAfter: context?.takenAfter,
    takenBefore: context?.takenBefore,
    ...scope,
  });
  const spaceId = 'spaceId' in scope ? scope.spaceId : undefined;
  return {
    countries: response.countries,
    cameraMakes: response.cameraMakes,
    tags: response.tags.map((t) => ({ id: t.id, name: t.value })),
    people: response.people.map((p) => ({
      id: spaceId ? p.id : getPhotosPersonFilterId(p),
      name: p.name,
      thumbnailUrl: getPhotosPersonFilterThumbnailUrl(p, spaceId),
    })),
    ratings: response.ratings,
    mediaTypes: response.mediaTypes,
    hasUnnamedPeople: response.hasUnnamedPeople,
    hasFavorites: response.hasFavorites,
    hasAssetsInAlbum: response.hasAssetsInAlbum,
    hasAssetsNotInAlbum: response.hasAssetsNotInAlbum,
  };
};

/** Browse-mode dependent providers (cities of a country, models of a make) for a scope. */
export const scopedProviders = (getScope: () => SuggestionScope) => ({
  cities: (country: string, context?: FilterContext) =>
    getSearchSuggestions({ $type: SearchSuggestionType.City, country, ...context, ...getScope() }),
  cameraModels: (make: string, context?: FilterContext) =>
    getSearchSuggestions({ $type: SearchSuggestionType.CameraModel, make, ...context, ...getScope() }),
});

/** Browse-mode panel config for a scope: every section, scoped suggestions, baseline and providers. */
export const scopedBrowseConfig = (getScope: () => SuggestionScope): FilterPanelConfig => ({
  sections: [...ALL_FILTER_SECTIONS],
  suggestionsProvider: (filters) => loadScopedSuggestions(filters, getScope()),
  baselineProvider: () => loadScopedSuggestions(createFilterState(), getScope()),
  providers: scopedProviders(getScope),
});
