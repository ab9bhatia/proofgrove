import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
export async function novaLinks() {
  const fallback = { baseline: '/evaluations', comparison: '/evaluations?tab=experiments' };
  try {
    const root = process.env.PROOFGROVE_ROOT || path.resolve(process.cwd(), '../../..');
    const state = JSON.parse(await readFile(path.join(root, 'backend/data/nova-seed.json'), 'utf8')).nova_ops_v1;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (![state.baseline, state.candidate, state.experiment_id].every((value) => typeof value === 'string' && uuid.test(value))) return fallback;
    return { baseline: `/runs/${state.baseline}`, comparison: `/evaluations/${state.experiment_id}/compare?baseline_run_id=${state.baseline}&candidate_run_id=${state.candidate}` };
  } catch { return fallback; }
}
