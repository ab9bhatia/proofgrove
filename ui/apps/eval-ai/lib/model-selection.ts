import type { LlmCatalogEntry } from '@/lib/api';

/** A model name can exist at multiple providers; selection must preserve its endpoint. */
export function modelSelectionId(model: { model_id: string; endpoint?: string | null }): string {
  return JSON.stringify([model.endpoint || '', model.model_id]);
}

export function findSelectedModel(models: LlmCatalogEntry[], selection: string): LlmCatalogEntry | null {
  const exact = models.find(model => modelSelectionId(model) === selection);
  if (exact) return exact;
  // Old saved drafts contain only the name. Restore them only when unambiguous.
  const legacy = models.filter(model => model.model_id === selection);
  return legacy.length === 1 ? legacy[0] : null;
}
