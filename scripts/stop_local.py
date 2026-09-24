#!/usr/bin/env python3
"""Stop only this project's recorded launcher."""
from pathlib import Path
import os
import signal
import subprocess
import time

root = Path(__file__).resolve().parents[1]
pid_file = root / '.local/launcher.pid'
if not pid_file.exists():
    raise SystemExit('No recorded Proofgrove launcher. Use Ctrl+C in its terminal if it was started manually.')
pid = int(pid_file.read_text())
command = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True).stdout
if str(root / 'scripts/run_local.py') not in command:
    raise SystemExit('The recorded PID is no longer this Proofgrove launcher; no process was stopped.')
os.kill(pid, signal.SIGTERM)
print('Stopping Proofgrove API, UI and any owned local model server. Your data is preserved.', flush=True)
# Wait for the launcher itself, not just its closed ports. Its finally block
# must complete before a subsequent startup claims the PID record.
for _ in range(300):
    running = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True).stdout
    if str(root / 'scripts/run_local.py') not in running:
        print('Proofgrove stopped.')
        break
    time.sleep(0.1)
else:
    raise SystemExit('The launcher is still shutting down. Wait for it to finish before restarting.')
