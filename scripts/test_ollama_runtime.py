import io
import json
import signal
import unittest
from unittest.mock import patch
from ollama_runtime import ensure_local_model, model_metadata

LOCAL = {'details': {'format': 'gguf'}, 'model_info': {'general.architecture': 'llama'}}
ENV = {'PROOFGROVE_MODEL': 'llama3.2:latest'}


class RuntimeTests(unittest.TestCase):
    def test_reuses_server_only_after_checking_local_metadata(self):
        with patch('ollama_runtime.installed_models', return_value={'llama3.2:latest'}), patch('ollama_runtime.model_metadata', return_value=LOCAL) as metadata, patch('ollama_runtime.subprocess.Popen') as spawn:
            self.assertIsNone(ensure_local_model(ENV, None))
            metadata.assert_called_once_with('llama3.2:latest')
            spawn.assert_not_called()

    def test_bare_alias_resolves_to_installed_metadata(self):
        with patch('ollama_runtime.installed_models', return_value={'llama3.2:latest'}), patch('ollama_runtime.model_metadata', return_value=LOCAL) as metadata:
            self.assertIsNone(ensure_local_model({'PROOFGROVE_MODEL': 'llama3.2'}, None))
            metadata.assert_called_once_with('llama3.2:latest')

    def test_missing_model_does_not_download_or_spawn(self):
        with patch('ollama_runtime.installed_models', return_value={'llama3.2:latest'}), patch('ollama_runtime.subprocess.Popen') as spawn, patch('ollama_runtime.model_metadata') as metadata:
            with self.assertRaisesRegex(RuntimeError, 'not installed'):
                ensure_local_model({'PROOFGROVE_MODEL': 'missing'}, None)
            spawn.assert_not_called()
            metadata.assert_not_called()

    def test_remote_or_unverifiable_models_are_rejected_without_stopping_reused_server(self):
        invalid = [dict(LOCAL, remote_model='cloud'), dict(LOCAL, remote_host='https://ollama.com'),
                   dict(LOCAL, model_info={'general.architecture': 'llama', 'remote_host': 'cloud'}),
                   {'details': {'format': 'unknown'}, 'model_info': {'general.architecture': 'llama'}},
                   {'details': {'format': 'gguf'}}, None]
        for metadata in invalid:
            with self.subTest(metadata=metadata), patch('ollama_runtime.installed_models', return_value={'llama3.2:latest'}), patch('ollama_runtime.model_metadata', return_value=metadata), patch('ollama_runtime.os.killpg') as stop:
                with self.assertRaises(RuntimeError):
                    ensure_local_model(ENV, None)
                stop.assert_not_called()

    def test_metadata_request_is_show_not_generation_or_download(self):
        with patch('ollama_runtime.urllib.request.urlopen', return_value=io.BytesIO(json.dumps(LOCAL).encode())) as open_url:
            self.assertEqual(model_metadata('llama3.2:latest'), LOCAL)
            request = open_url.call_args.args[0]
            self.assertEqual(request.full_url, 'http://127.0.0.1:11434/api/show')
            self.assertEqual(json.loads(request.data), {'name': 'llama3.2:latest'})

    def test_new_server_disables_cloud_and_transfers_ownership_on_success(self):
        with patch('ollama_runtime.installed_models', side_effect=[OSError(), {'llama3.2:latest'}]), patch('ollama_runtime.shutil.which', return_value='/usr/local/bin/ollama'), patch('ollama_runtime.subprocess.Popen') as spawn, patch('ollama_runtime.model_metadata', return_value=LOCAL), patch('ollama_runtime.os.killpg') as stop:
            spawn.return_value.poll.return_value = None
            self.assertIs(ensure_local_model(ENV, None), spawn.return_value)
            self.assertEqual(spawn.call_args.kwargs['env']['OLLAMA_HOST'], '127.0.0.1:11434')
            self.assertEqual(spawn.call_args.kwargs['env']['OLLAMA_NO_CLOUD'], '1')
            stop.assert_not_called()

    def test_new_server_is_cleaned_up_if_profile_model_missing(self):
        with patch('ollama_runtime.installed_models', side_effect=[OSError(), {'existing'}]), patch('ollama_runtime.shutil.which', return_value='/usr/local/bin/ollama'), patch('ollama_runtime.subprocess.Popen') as spawn, patch('ollama_runtime.os.killpg') as stop:
            spawn.return_value.poll.return_value = None
            spawn.return_value.pid = 123
            with self.assertRaisesRegex(RuntimeError, 'not installed'):
                ensure_local_model({'PROOFGROVE_MODEL': 'missing'}, None)
            stop.assert_called_once_with(123, signal.SIGTERM)
            spawn.return_value.wait.assert_called_once_with(timeout=5)

    def test_signal_cancellation_before_ownership_transfer_stops_new_server(self):
        for interruption in (SystemExit, KeyboardInterrupt):
            with self.subTest(interruption=interruption.__name__), patch('ollama_runtime.installed_models', side_effect=[OSError(), interruption()]), patch('ollama_runtime.shutil.which', return_value='/usr/local/bin/ollama'), patch('ollama_runtime.subprocess.Popen') as spawn, patch('ollama_runtime.os.killpg') as stop:
                spawn.return_value.poll.return_value = None
                spawn.return_value.pid = 456
                with self.assertRaises(interruption):
                    ensure_local_model(ENV, None)
                stop.assert_called_once_with(456, signal.SIGTERM)
                spawn.return_value.wait.assert_called_once_with(timeout=5)

    def test_cancellation_during_metadata_validation_stops_new_server(self):
        with patch('ollama_runtime.installed_models', side_effect=[OSError(), {'llama3.2:latest'}]), patch('ollama_runtime.shutil.which', return_value='/usr/local/bin/ollama'), patch('ollama_runtime.subprocess.Popen') as spawn, patch('ollama_runtime.model_metadata', side_effect=SystemExit), patch('ollama_runtime.os.killpg') as stop:
            spawn.return_value.poll.return_value = None
            spawn.return_value.pid = 789
            with self.assertRaises(SystemExit):
                ensure_local_model(ENV, None)
            stop.assert_called_once_with(789, signal.SIGTERM)


if __name__ == '__main__':
    unittest.main()
