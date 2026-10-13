"""Bounded hosted-runner cleanup of freshly allocated synthetic data only."""
from contextlib import contextmanager
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile

PREFIXES = {'rc3-init-synthetic-': 'startup', 'rc3-push-compiled-': 'packaged-runtime'}


@contextmanager
def temporary_data(prefix, receipt_path):
    if (sys.platform != 'linux' or prefix not in PREFIXES
            or not shutil.rmtree.avoids_symlink_attacks):
        raise RuntimeError('synthetic_temp_scope_invalid')
    base = pathlib.Path(tempfile.gettempdir()).resolve(strict=True)
    if base != pathlib.Path('/tmp'):
        raise RuntimeError('synthetic_temp_scope_invalid')
    root = pathlib.Path(tempfile.mkdtemp(prefix=prefix))
    allocated = root.lstat()
    uid, gid = os.getuid(), os.getgid()
    completed = False
    receipt = {'schema': 1, 'phase': PREFIXES[prefix], 'hostedOnly': True,
               'taskOwnedSyntheticDataOnly': True, 'noSymlinkTraversal': True,
               'ownershipRepairUsed': False, 'cleanupComplete': False,
               'preservedOnFailure': False}

    def validate():
        current = root.lstat()
        if (root.parent != base or root.is_symlink()
                or root.resolve(strict=True) != root
                or not re.fullmatch(re.escape(prefix) + r'[a-z0-9_]+', root.name)
                or not stat.S_ISDIR(current.st_mode)
                or (current.st_dev, current.st_ino) != (allocated.st_dev, allocated.st_ino)
                or current.st_uid != uid or type(uid) is not int or type(gid) is not int
                or uid < 0 or gid < 0):
            raise RuntimeError('synthetic_temp_scope_invalid')

    try:
        validate()
        yield root
        completed = True
    finally:
        if not completed:
            # Failed or still-running fixtures retain their synthetic mount data.
            # The disposable hosted runner owns eventual teardown.
            receipt['preservedOnFailure'] = True
        else:
            try:
                validate()
                try:
                    shutil.rmtree(root)
                except PermissionError:
                    # Container-root transform caches can be unreadable to the runner.
                    # GNU chown -P -h neither traverses nor dereferences symlinks.
                    validate()
                    receipt['ownershipRepairUsed'] = True
                    result = subprocess.run(
                        ['sudo', '-n', 'chown', '-R', '-P', '-h', '--',
                         f'{uid}:{gid}', str(root)],
                        capture_output=True, text=True, timeout=20)
                    if result.returncode:
                        raise RuntimeError('synthetic_temp_ownership_repair_failed')
                    validate()
                    shutil.rmtree(root)
                receipt['cleanupComplete'] = True
            except Exception as error:
                receipt['preservedOnFailure'] = True
                known = {'synthetic_temp_scope_invalid', 'synthetic_temp_ownership_repair_failed'}
                marker = str(error) if str(error) in known else 'synthetic_temp_cleanup_failed'
                receipt['failureMarker'] = marker
                receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
                raise RuntimeError(marker) from None
        receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
