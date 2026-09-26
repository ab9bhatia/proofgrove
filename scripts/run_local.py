#!/usr/bin/env python3
"""Run the two-process Proofgrove classroom lab; Ctrl+C stops both children."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from lab_profile import environments
from ollama_runtime import ensure_local_model

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.local'
PROCESSES: list[subprocess.Popen] = []


def stop(*_args):
    for process in reversed(PROCESSES):
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for process in reversed(PROCESSES):
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
    raise SystemExit(0)


def release_pid_file(path, pid):
    # An older launcher must not remove a newer launcher's ownership record.
    try:
        if path.read_text().strip() == str(pid):
            path.unlink(missing_ok=True)
    except FileNotFoundError:
        pass


def main():
    for command in ('uv', 'pnpm'):
        if not shutil.which(command):
            raise SystemExit(f'{command} is required. See README.md, then run ./setup.sh.')
    for port in (8010, 3010):
        with socket.socket() as check:
            # Recently closed local connections must not look like a running
            # server during a restart. An active listener still rejects bind.
            check.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                check.bind(('127.0.0.1', port))
            except OSError:
                raise SystemExit(f'Port {port} is already in use. Stop that process or use the running Proofgrove lab.')
    if not (ROOT / 'backend/.venv').exists() or not (ROOT / 'ui/node_modules').exists():
        raise SystemExit('Dependencies are missing. Run ./setup.sh first.')
    LOCAL.mkdir(exist_ok=True)
    (ROOT / 'backend/data').mkdir(exist_ok=True)
    try:
        env, seed_env, ui_env = environments(os.environ, ROOT)
    except ValueError as exc:
        raise SystemExit(str(exc)) from None
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    pid_file = LOCAL / 'launcher.pid'
    pid_file.write_text(str(os.getpid()))
    logs = []
    try:
        if env['PROOFGROVE_MODE'] == 'local':
            ollama_log = open(LOCAL / 'ollama.log', 'a', buffering=1)
            logs.append(ollama_log)
            ollama = ensure_local_model(env, ollama_log)
            if ollama is not None:
                PROCESSES.append(ollama)
        print('Preparing classroom data (existing data is preserved)…', flush=True)
        seed = subprocess.run(['uv', 'run', '--no-sync', 'python', '../scripts/seed_demo.py'], cwd=ROOT / 'backend', env=seed_env)
        if seed.returncode:
            raise RuntimeError('Classroom seed failed; review the error above.')
        learning_seed = subprocess.run(['uv', 'run', '--no-sync', 'python', '../scripts/seed_learning.py'], cwd=ROOT / 'backend', env=seed_env)
        if learning_seed.returncode:
            raise RuntimeError('Learning fixture seed failed; review the error above.')
        nova_seed = subprocess.run(['uv', 'run', '--no-sync', 'python', '../scripts/seed_nova.py'], cwd=ROOT / 'backend', env=seed_env)
        if nova_seed.returncode:
            raise RuntimeError('Nova fixture seed failed; review the error above.')
        starter = subprocess.run(['uv', 'run', '--no-sync', 'python', '../scripts/seed_live_starter.py'], cwd=ROOT / 'backend', env=seed_env)
        if starter.returncode:
            raise RuntimeError('Live starter suite seed failed; review the error above.')
        refunds = subprocess.run(['uv', 'run', '--no-sync', 'python', '../scripts/seed_refund_demo.py'], cwd=ROOT / 'backend', env=seed_env)
        if refunds.returncode:
            raise RuntimeError('Refund golden dataset preparation failed; review the error above.')
        ready = subprocess.run(['uv', 'run', '--no-sync', 'python', '../scripts/seed_ready_evaluation.py'], cwd=ROOT / 'backend', env=seed_env)
        if ready.returncode:
            raise RuntimeError('Prepared evaluation artifacts failed to initialize; review the error above.')
        working_agents = subprocess.run(['uv', 'run', '--no-sync', 'python', '../scripts/seed_working_agents.py'], cwd=ROOT / 'backend', env=seed_env)
        if working_agents.returncode:
            raise RuntimeError('Working-agent golden datasets failed to initialize; review the error above.')
        api_log = open(LOCAL / 'api.log', 'a', buffering=1)
        logs.append(api_log)
        api_process = subprocess.Popen(
            ['uv', 'run', '--no-sync', 'uvicorn', 'proofgrove.main:app', '--host', '127.0.0.1', '--port', '8010'],
            cwd=ROOT / 'backend', env=env, stdout=api_log, stderr=subprocess.STDOUT, start_new_session=True,
        )
        PROCESSES.append(api_process)
        print('Starting Proofgrove API…', flush=True)
        for _ in range(120):
            if api_process.poll() is not None:
                raise RuntimeError('API exited; inspect .local/api.log.')
            try:
                with urllib.request.urlopen('http://127.0.0.1:8010/health/live', timeout=1) as response:
                    if response.status == 200:
                        break
            except (OSError, TimeoutError):
                time.sleep(0.5)
        else:
            raise RuntimeError('API startup timed out; inspect .local/api.log.')
        ui_log = open(LOCAL / 'ui.log', 'a', buffering=1)
        logs.append(ui_log)
        built = (ROOT / 'ui/apps/eval-ai/.next/BUILD_ID').exists()
        command = 'start' if built else 'dev'
        PROCESSES.append(subprocess.Popen(
            ['pnpm', '--filter', '@evalai/eval-ai', command],
            cwd=ROOT / 'ui', env=ui_env, stdout=ui_log, stderr=subprocess.STDOUT, start_new_session=True,
        ))
        print(f'\nProofgrove → http://understandeval.localhost:3010/\nPresenter → http://localhost:3010/presenter\nMode: {env["PROOFGROVE_MODE"]}. Semantic judge remains mock/unscored; deterministic checks compute real scores.\nModel generation uses the provider selected in Models. OpenAI calls may incur charges.\nKeep this terminal open. Press Ctrl+C to stop.\n', flush=True)
        while all(process.poll() is None for process in PROCESSES):
            time.sleep(1)
        raise RuntimeError('A service exited. Inspect .local/api.log and .local/ui.log.')
    except (RuntimeError, OSError) as exc:
        print(str(exc), file=sys.stderr, flush=True)
        for process in PROCESSES:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
        return 1
    finally:
        for log in logs:
            log.close()
        release_pid_file(pid_file, os.getpid())
    return 0


if __name__ == '__main__':
    sys.exit(main())
