import type { DatasetRunRequest } from '@/lib/api';
import type { BakeoffTarget } from '@/lib/bakeoff';

export interface ModelProfile { id: string; name: string; model: string | null; endpoint?: string; provider?: string }
export interface LabConfiguration { live: boolean; mode?: string; provider?: string; model: string | null; endpoint?: string | null; profiles: ModelProfile[] }
export type AbAxis = 'prompts' | 'models' | 'agents';
export interface AbSelection { axis: AbAxis; name: string; models: [string, string]; endpoints?: [string, string]; prompts: [string, string]; agents: [string, string]; rows: number }
export const AB_METRICS = ['nlp.f1_score', 'nlp.rouge', 'nlp.bleu'];

export function abRequests(selection: AbSelection): [DatasetRunRequest, DatasetRunRequest] {
  if (!selection.name.trim()) throw new Error('Name this comparison.');
  if (!Number.isInteger(selection.rows) || selection.rows < 1 || selection.rows > 8) throw new Error('Choose between one and eight cases per side.');
  const { axis, prompts, models, agents, endpoints } = selection;
  if (axis === 'agents') {
    if (!agents[0] || !agents[1] || agents[0] === agents[1]) throw new Error('Choose two different registered agents.');
  } else {
    if (!models[0] || (axis === 'models' && !models[1])) throw new Error('Configure the actual model before running.');
    if (!endpoints?.[0] || (axis === 'models' && !endpoints[1])) throw new Error('Choose a connected model endpoint for each side.');
    if (!prompts[0] || (axis === 'prompts' && !prompts[1])) throw new Error('Choose saved prompt versions for both sides.');
    if (axis === 'prompts' && prompts[0] === prompts[1]) throw new Error('Choose different prompt versions.');
  }
  const common: DatasetRunRequest = { evaluation_name: selection.name.trim(), row_count: selection.rows, active_metrics: AB_METRICS, enable_llm_judge: false, parallel_requests: 1, run_human_review: true, evaluation_scope: 'final_response' };
  return [0, 1].map((i) => axis === 'agents'
    ? { ...common, label: `${i ? 'B' : 'A'} — ${agents[i]}`, response_source: 'agent', agent: agents[i] }
    : { ...common, label: `${i ? 'B' : 'A'} — ${models[axis === 'prompts' ? 0 : i]} / ${prompts[axis === 'models' ? 0 : i]}`, response_source: 'llm', target_model: models[axis === 'prompts' ? 0 : i], target_endpoint: endpoints![axis === 'prompts' ? 0 : i], prompt_version_ref: prompts[axis === 'models' ? 0 : i] }) as [DatasetRunRequest, DatasetRunRequest];
}

export async function launchAbPair(requests: [DatasetRunRequest, DatasetRunRequest], create: (request: DatasetRunRequest) => Promise<{ run_id?: string | null; status?: string }>, persist: (targets: BakeoffTarget[]) => void) {
  const targets: BakeoffTarget[] = requests.map((request) => ({ modelId: request.label!, runId: null, status: 'not_started', error: null }));
  persist([...targets]); // Refuse to spend when recovery information cannot be stored.
  for (let i = 0; i < 2; i++) {
    targets[i] = { ...targets[i], status: 'starting' };
    persist([...targets]);
    try {
      const job = await create(requests[i]);
      if (!job.run_id) throw new Error('No run ID returned');
      targets[i] = { ...targets[i], runId: job.run_id, status: job.status || 'pending' };
    } catch {
      targets[i] = { ...targets[i], status: 'unknown', error: 'Could not confirm launch. Check Run history before retrying; a request may have reached the server.' };
    }
    persist([...targets]); // Save A before starting B; never auto-retry a POST.
  }
  return targets;
}
