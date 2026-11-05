#!/usr/bin/env python3
"""One-time root installation of the optional reader; never restart existing APIs."""
import argparse
import datetime
import os
from pathlib import Path
import pwd
import shutil
import subprocess

from install_host import validate_baseline


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--user', default='neuro')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run once as root; CI must never run this installer')
    account = pwd.getpwnam(args.user)
    runtime = Path(account.pw_dir) / '.local/share/edo-ocr'
    validate_baseline(runtime)
    component = Path(__file__).resolve().parents[2]
    backup = runtime / ('admin-backup-typecheck-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(mode=0o700)
    unit = Path('/etc/systemd/system/recognize-typecheck.service')
    control = Path('/usr/local/sbin/edo-ocr-systemctl')
    for path in (unit, control):
        if path.is_file():
            shutil.copy2(path, backup / path.name)
    text = (component / 'deploy/systemd/recognize-typecheck.service').read_text()
    text = text.replace('/opt/edo.sps38.pro/ocr', str(runtime / 'current'))
    text = text.replace('User=ocr', 'User=' + args.user).replace('Group=ocr', 'Group=' + args.user)
    text = text.replace('Environment=PYTHONUNBUFFERED=1',
                        f'Environment=PYTHONUNBUFFERED=1\nEnvironment=MODELS_ROOT={runtime}/shared/models')
    unit.write_text(text)
    unit.chmod(0o644)
    shutil.copyfile(component / 'deploy/runner/edo-ocr-systemctl', control)
    control.chmod(0o755)
    os.chown(control, 0, 0)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', 'recognize-typecheck.service'], check=True)
    print('Optional reader unit installed; existing APIs and runner were not restarted')


if __name__ == '__main__':
    main()
