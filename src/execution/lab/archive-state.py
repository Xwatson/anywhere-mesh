"""Archive stopped experiment journals for independent crash-window test cases."""
import os, socket, subprocess, sys
from pathlib import Path
assert os.getuid() == 0 and socket.gethostname() == 'anywhere-crossborder-lab'
base = Path('/srv/anywhere-lab/execution-b')
label = sys.argv[1]
assert label and all(c.isalnum() or c in '-_' for c in label)
for role in ['agent', 'broker']:
    state = subprocess.check_output(['systemctl', 'show', '-p', 'ActiveState', '--value', f'anywhere-execution-{role}.service'], text=True).strip()
    assert state in ['inactive', 'failed'], state
archive = base / 'archive' / label
archive.mkdir(parents=True, mode=0o700, exist_ok=False)
for role in ['agent', 'broker']:
    dest = archive / role
    dest.mkdir(mode=0o700)
    for name in ['journal.sqlite', 'journal.sqlite-wal', 'journal.sqlite-shm', 'mock-effects.jsonl', 'fault.json']:
        path = base / role / name
        if path.exists():
            assert path.is_file() and not path.is_symlink()
            path.rename(dest / name)
print(archive)
