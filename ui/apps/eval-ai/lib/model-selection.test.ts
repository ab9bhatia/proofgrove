import { describe, expect, it } from 'vitest';
import { modelSelectionId, findSelectedModel } from './model-selection';
import type { LlmCatalogEntry } from './api';
const models: LlmCatalogEntry[] = [
  { model_id: 'same', name: 'Cloud', source: 'openai', endpoint: 'https://api.openai.com/v1' },
  { model_id: 'same', name: 'Local', source: 'ollama', endpoint: 'http://127.0.0.1:11434/v1' },
];
describe('model provider identity', () => {
  it('keeps equally named models at different endpoints distinct', () => {
    expect(modelSelectionId(models[0])).not.toBe(modelSelectionId(models[1]));
    expect(findSelectedModel(models, modelSelectionId(models[1]))).toBe(models[1]);
  });
  it('restores old model-only selections only when unambiguous', () => {
    expect(findSelectedModel(models, 'same')).toBeNull();
    expect(findSelectedModel(models.slice(0, 1), 'same')).toBe(models[0]);
    expect(findSelectedModel(models, 'missing')).toBeNull();
  });
});
