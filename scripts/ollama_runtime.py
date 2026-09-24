"""Start only a verified local GGUF Ollama runtime; never download or infer."""
import json
import os
import shutil
import signal
import subprocess
import time
import urllib.request


def installed_models():
    with urllib.request.urlopen('http://127.0.0.1:11434/api/tags', timeout=2) as response:
        data = json.load(response)
    return {model['name'] for model in data.get('models', [])}


def model_metadata(name):
    # /api/show only reads metadata. `name` also supports the installed 0.3.11
    # runtime; no generation, pull or model-loading request is sent.
    request = urllib.request.Request('http://127.0.0.1:11434/api/show',
        data=json.dumps({'name': name}).encode(), headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def _has_remote_fields(value):
    if isinstance(value, dict):
        return any(key in ('remote_model', 'remote_host') or _has_remote_fields(item)
                   for key, item in value.items())
    if isinstance(value, list):
        return any(_has_remote_fields(item) for item in value)
    return False


def verify_local_model(name):
    try:
        metadata = model_metadata(name)
    except (OSError, ValueError, TypeError) as exc:
        raise RuntimeError(f'Cannot verify local model metadata for {name}; no model was invoked.') from exc
    if _has_remote_fields(metadata):
        raise RuntimeError(f'{name} is cloud-backed or declares remote model fields. Local mode requires downloaded GGUF weights.')
    details = metadata.get('details') if isinstance(metadata, dict) else None
    model_info = metadata.get('model_info') if isinstance(metadata, dict) else None
    if (not isinstance(details, dict) or details.get('format') != 'gguf'
            or not isinstance(model_info, dict) or not model_info.get('general.architecture')):
        raise RuntimeError(f'Cannot establish local GGUF-backed weights for {name}: model format or architecture is missing or unsupported. Choose an installed local GGUF model.')


def _stop_owned_process(process):
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            return
        process.wait(timeout=2)


def ensure_local_model(env, log):
    process = None
    try:
        try:
            names = installed_models()
        except (OSError, ValueError):
            command = shutil.which('ollama')
            if not command:
                raise RuntimeError('Ollama is not installed. Install it and a model, or use the cloud live profile.') from None
            local_env = dict(env, OLLAMA_HOST='127.0.0.1:11434', OLLAMA_NUM_PARALLEL='1',
                             OLLAMA_MAX_LOADED_MODELS='1', OLLAMA_NO_CLOUD='1')
            process = subprocess.Popen([command, 'serve'], env=local_env, stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            for _ in range(60):
                if process.poll() is not None:
                    raise RuntimeError('Ollama exited; inspect .local/ollama.log.')
                try:
                    names = installed_models()
                    break
                except (OSError, ValueError):
                    time.sleep(0.25)
            else:
                raise RuntimeError('Ollama startup timed out; inspect .local/ollama.log.')
        requested = {env.get(key, '').strip() for key in ('PROOFGROVE_MODEL', 'PROOFGROVE_MODEL_A', 'PROOFGROVE_MODEL_B', 'PROOFGROVE_MODEL_C')} - {''}
        missing = {name for name in requested if name not in names and name + ':latest' not in names}
        if missing:
            raise RuntimeError('Local model is not installed: ' + ', '.join(sorted(missing)) + '. Choose an existing model with PROOFGROVE_MODEL.')
        for name in sorted(requested):
            verify_local_model(name if name in names else name + ':latest')
        print('Local Ollama ready: ' + ', '.join(sorted(requested)) + '. Responses are generated on this Mac.', flush=True)
        return process
    except BaseException:
        # The launcher's signal handler raises SystemExit. Ownership has not
        # transferred to it until this helper returns, so cancellation here
        # must also stop our child. A reused server is never stopped.
        try:
            _stop_owned_process(process)
        except (OSError, subprocess.TimeoutExpired):
            pass
        raise
