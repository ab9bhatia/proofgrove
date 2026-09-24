import "server-only";
import { evalHubBaseUrl } from '@/lib/eval-hub';
import { resolveTenant } from '@/lib/tenant';
import { modelSelectionId } from '@/lib/model-selection';
import type { LabConfiguration } from '@/lib/ab-test';

type ProviderStatus = {
  providers: { id: string; connected: boolean; models: { model_id: string; name: string; endpoint: string }[] }[];
  default: { provider: string; model_id: string; endpoint: string } | null;
};

export function configurationFromProviders(status: ProviderStatus, mode: string): LabConfiguration {
  const available = status.providers.filter(p => p.connected).flatMap(p => p.models.map(m => ({
    id: modelSelectionId(m), name: `${p.id === 'ollama' ? 'Ollama · local' : 'OpenAI'} · ${m.name}`,
    model: m.model_id, endpoint: m.endpoint, provider: p.id,
  })));
  const selected = status.default;
  const defaultProfile = selected && available.find(p => p.model === selected.model_id && p.endpoint === selected.endpoint && p.provider === selected.provider);
  return {
    mode, live: available.length > 0, provider: defaultProfile?.provider, model: defaultProfile?.model ?? null,
    endpoint: defaultProfile?.endpoint ?? null,
    profiles: defaultProfile ? [defaultProfile, ...available.filter(p => p.id !== defaultProfile.id)] : available,
  };
}

export async function labMode(): Promise<LabConfiguration> {
  const mode = process.env.PROOFGROVE_MODE || 'offline';
  const unavailable: LabConfiguration = { mode, live: false, model: null, endpoint: null, profiles: [] };
  if (mode !== 'local' && mode !== 'live') return unavailable;
  try {
    const response = await fetch(`${evalHubBaseUrl()}/evaluation/model-providers`, {
      headers: { 'x-evalai-tenant': resolveTenant().slice('tenant-'.length) },
      cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return unavailable;
    return configurationFromProviders(await response.json(), mode);
  } catch {
    return unavailable;
  }
}
