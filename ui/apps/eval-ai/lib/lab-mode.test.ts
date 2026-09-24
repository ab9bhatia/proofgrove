import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { configurationFromProviders, labMode } from './lab-mode';
const local = { model_id: 'same', name: 'same', endpoint: 'http://127.0.0.1:11434/v1' };
const cloud = { ...local, endpoint: 'https://api.openai.com/v1' };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('current provider configuration', () => {
  it('uses the saved provider default and preserves per-profile routing for A/B', () => {
    const result = configurationFromProviders({ providers: [
      { id: 'ollama', connected: true, models: [local] },
      { id: 'openai', connected: true, models: [cloud] },
    ], default: { provider: 'openai', ...cloud } }, 'local');
    expect(result.model).toBe('same'); expect(result.provider).toBe('openai');
    expect(result.profiles.map(p => p.endpoint)).toEqual([cloud.endpoint, local.endpoint]);
    expect(new Set(result.profiles.map(p => p.id)).size).toBe(2);
  });
  it('does not expose stale models from disconnected providers', () => {
    const result = configurationFromProviders({ providers: [{ id: 'openai', connected: false, models: [cloud] }], default: { provider: 'openai', ...cloud } }, 'local');
    expect(result.live).toBe(false); expect(result.model).toBeNull(); expect(result.profiles).toEqual([]);
  });
  it('never consults connections in offline seed mode', async () => {
    vi.stubEnv('PROOFGROVE_MODE', 'offline'); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect((await labMode()).live).toBe(false); expect(fetch).not.toHaveBeenCalled();
  });
  it('fails closed when the backend is unavailable', async () => {
    vi.stubEnv('PROOFGROVE_MODE', 'local'); vi.stubEnv('POD_NAMESPACE', 'tenant-local-classroom');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect((await labMode()).live).toBe(false);
  });
});
