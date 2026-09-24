import unittest
from pathlib import Path
from lab_profile import environments


class ProfileTests(unittest.TestCase):
    def test_offline_clears_credentials(self):
        runtime, seed, ui = environments({'OPENAI_API_KEY': 'test-secret', 'AZURE_OPENAI_API_KEY': 'test-secret'}, Path('/lab'))
        self.assertEqual(runtime['OPENAI_API_KEY'], '')
        self.assertEqual(seed['AZURE_OPENAI_API_KEY'], '')
        self.assertNotIn('OPENAI_API_KEY', ui)

    def test_live_is_explicit_and_seeding_stays_offline(self):
        source = dict(PROOFGROVE_MODE='live', PROOFGROVE_MODEL='chosen-model', OPENAI_API_KEY='test-secret', PROOFGROVE_ALLOW_PAID_CALLS='yes', PROOFGROVE_BUDGET_USD='1')
        runtime, seed, ui = environments(source, Path('/lab'))
        self.assertEqual(runtime['OPENAI_API_KEY'], 'test-secret')
        self.assertEqual(runtime['JUDGE_MODE'], 'mock')
        self.assertEqual(seed['OPENAI_API_KEY'], '')
        self.assertEqual(seed['PROOFGROVE_MODE'], 'offline')
        self.assertNotIn('OPENAI_API_KEY', ui)
        self.assertEqual(ui['PROOFGROVE_MODEL'], 'chosen-model')
        for key in ['OPENAI_API_KEY', 'PROOFGROVE_MODEL', 'PROOFGROVE_ALLOW_PAID_CALLS', 'PROOFGROVE_BUDGET_USD']:
            with self.assertRaises(ValueError):
                environments({k: v for k, v in source.items() if k != key}, Path('/lab'))
        for invalid in ['NaN', 'Infinity', '-1', 'abc']:
            with self.assertRaises(ValueError):
                environments(dict(source, PROOFGROVE_BUDGET_USD=invalid), Path('/lab'))

    def test_local_runs_without_cloud_keys_and_resets_provider(self):
        source = dict(PROOFGROVE_MODE='local', OPENAI_API_KEY='cloud-secret', OPENAI_BASE_URL='https://bad.example', PROOFGROVE_MODEL_B='cloud-model')
        runtime, seed, ui = environments(source, Path('/lab'))
        self.assertEqual(runtime['OPENAI_BASE_URL'], 'http://127.0.0.1:11434/v1')
        self.assertEqual(runtime['OPENAI_API_KEY'], '')
        self.assertEqual(runtime['PROOFGROVE_MODEL'], 'llama3.2:latest')
        self.assertEqual(runtime['PROOFGROVE_MODEL_B'], 'llama3.2:latest')
        self.assertNotIn('OPENAI_API_KEY', ui)
        self.assertEqual(seed['PROOFGROVE_MODE'], 'offline')
        self.assertEqual(seed['OPENAI_API_KEY'], '')
        self.assertEqual(runtime['JUDGE_MODE'], 'mock')

    def test_only_acknowledged_live_openai_key_is_forwarded(self):
        credentials = {'OPENAI_API_KEY': 'openai-secret', 'AZURE_OPENAI_API_KEY': 'azure-secret',
                       'OLLAMA_API_KEY': 'ollama-secret', 'ANTHROPIC_API_KEY': 'other-secret',
                       'API_KEY': 'generic-secret'}
        for mode in ('offline', 'local', 'live'):
            source = dict(credentials, PROOFGROVE_MODE=mode, PROOFGROVE_MODEL='installed-model',
                          PROOFGROVE_ALLOW_PAID_CALLS='yes', PROOFGROVE_BUDGET_USD='1')
            runtime, seed, ui = environments(source, Path('/lab'))
            self.assertEqual(runtime['OPENAI_API_KEY'], 'openai-secret' if mode == 'live' else '')
            for key in ('OLLAMA_API_KEY', 'ANTHROPIC_API_KEY', 'API_KEY'):
                self.assertNotIn(key, runtime)
                self.assertNotIn(key, seed)
                self.assertNotIn(key, ui)
            self.assertEqual(seed['OPENAI_API_KEY'], '')
            self.assertEqual(seed['AZURE_OPENAI_API_KEY'], '')
            self.assertEqual(source['OLLAMA_API_KEY'], 'ollama-secret')

    def test_unknown_mode_fails_closed(self):
        with self.assertRaises(ValueError):
            environments({'PROOFGROVE_MODE': 'typo'}, Path('/lab'))


if __name__ == '__main__':
    unittest.main()
