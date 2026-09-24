import { describe, expect, it, vi } from 'vitest';
import { abRequests, launchAbPair, type AbSelection } from './ab-test';

const selection: AbSelection = { axis: 'prompts', name: 'Refund demo', models: ['actual-a', 'actual-b'], endpoints: ['http://127.0.0.1:11434/v1', 'https://api.openai.com/v1'], prompts: ['nova@1', 'nova@2'], agents: ['demo/a', 'demo/b'], rows: 5 };

describe('controlled A/B requests', () => {
  it('changes only the prompt when comparing prompts', () => {
    const [a, b] = abRequests(selection);
    expect(a.target_model).toBe('actual-a'); expect(b.target_model).toBe('actual-a');
    expect(a.target_endpoint).toBe('http://127.0.0.1:11434/v1'); expect(b.target_endpoint).toBe(a.target_endpoint);
    expect(a.prompt_version_ref).toBe('nova@1'); expect(b.prompt_version_ref).toBe('nova@2');
    expect(a.active_metrics).toEqual(b.active_metrics);
    expect(a.enable_llm_judge).toBe(false); expect(a.parallel_requests).toBe(1);
  });
  it('holds the prompt fixed when comparing actual models', () => {
    const [a, b] = abRequests({ ...selection, axis: 'models' });
    expect(a.target_model).toBe('actual-a'); expect(b.target_model).toBe('actual-b');
    expect(a.prompt_version_ref).toBe(b.prompt_version_ref);
    expect(a.target_endpoint).toBe('http://127.0.0.1:11434/v1');
    expect(b.target_endpoint).toBe('https://api.openai.com/v1');
  });
  it('uses registered agent identities without overriding their models or prompts', () => {
    const [a, b] = abRequests({ ...selection, axis: 'agents' });
    expect(a.agent).toBe('demo/a'); expect(b.agent).toBe('demo/b');
    expect(a.response_source).toBe('agent'); expect(a.target_model).toBeUndefined();
    expect(a.prompt_version_ref).toBeUndefined();
  });
  it('rejects duplicate prompts, unconfigured models and excessive rows', () => {
    expect(() => abRequests({ ...selection, prompts: ['same@1', 'same@1'] })).toThrow('different');
    expect(() => abRequests({ ...selection, models: ['', ''] })).toThrow('actual model');
    expect(() => abRequests({ ...selection, endpoints: undefined })).toThrow('endpoint');
    expect(() => abRequests({ ...selection, rows: 9 })).toThrow('eight');
  });
});

describe('recoverable A/B launch', () => {
  it('persists A before issuing B', async () => {
    const persisted: string[][] = [];
    const create = vi.fn().mockImplementationOnce(async () => ({ run_id: 'run-a', status: 'pending' })).mockImplementationOnce(async () => {
      expect(persisted.some(ids => ids.includes('run-a'))).toBe(true);
      return { run_id: 'run-b', status: 'pending' };
    });
    const result = await launchAbPair(abRequests(selection), create, targets => persisted.push(targets.flatMap(t => t.runId ? [t.runId] : [])));
    expect(result.map(t => t.runId)).toEqual(['run-a', 'run-b']);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('keeps the successful run when the other response is lost and never retries', async () => {
    const create = vi.fn().mockResolvedValueOnce({ run_id: 'run-a' }).mockRejectedValueOnce(new Error('connection lost'));
    const result = await launchAbPair(abRequests(selection), create, vi.fn());
    expect(result[0].runId).toBe('run-a'); expect(result[1].status).toBe('unknown');
    expect(result[1].error).toContain('Run history'); expect(create).toHaveBeenCalledTimes(2);
  });
  it('does not spend if recovery storage fails before launch', async () => {
    const create = vi.fn();
    await expect(launchAbPair(abRequests(selection), create, () => { throw new Error('storage full'); })).rejects.toThrow('storage full');
    expect(create).not.toHaveBeenCalled();
  });
  it('does not launch B if saving the returned A identity fails', async () => {
    const create = vi.fn().mockResolvedValue({ run_id: 'run-a' });
    await expect(launchAbPair(abRequests(selection), create, targets => { if (targets[0].runId) throw new Error('storage full'); })).rejects.toThrow('storage full');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
