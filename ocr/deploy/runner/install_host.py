#!/usr/bin/env python3
"""One-time root setup for the already registered OCR PC runner and services."""
import argparse
import datetime
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import tomllib


def validate_baseline(runtime):
    current = runtime / 'current'
    try:
        release = current.resolve(strict=True)
        metadata = json.loads((release / 'release.json').read_text())
        verification = runtime / 'deployed.json' if (runtime / 'deployed.json').exists() else runtime / 'baseline-verified.json'
        verified = json.loads(verification.read_text())
        if not re.fullmatch(r'[0-9a-f]{40}', metadata.get('commit', '')) or not all(metadata.get(k) for k in ('glm_key', 'glm_image')):
            raise ValueError('Incomplete baseline release metadata')
        if not current.is_symlink() or not release.is_relative_to(runtime / 'releases'):
            raise ValueError('Current must point to a managed release')
        if verified.get('commit') != metadata.get('commit') or not verified.get('real_inference_verified'):
            raise ValueError('Baseline inference must match current release')
        for service in ('uz', 'ru'):
            if not (release / 'services' / service / '.venv/bin/python').is_file():
                raise ValueError('Baseline Python environment missing')
        if not (runtime / 'shared/models').is_dir():
            raise ValueError('Baseline models missing')
    except (OSError, ValueError, KeyError) as error:
        raise ValueError('Prepare and verify a managed baseline before installing host services') from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--user', default='neuro')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run once as root; CI must never run this installer')
    account = pwd.getpwnam(args.user)
    home = Path(account.pw_dir)
    runtime = home / '.local/share/edo-ocr'
    validate_baseline(runtime)
    component = Path(__file__).resolve().parents[2]
    source_config = home / '.gitlab-runner/config.toml'
    configuration = source_config.read_text()
    data = tomllib.loads(configuration)
    runners = data.get('runners', [])
    if len(runners) != 1 or runners[0].get('name') != 'deploy-ocr-pc' or runners[0].get('executor') != 'shell':
        raise ValueError('Expected exactly one registered deploy-ocr-pc shell runner')
    target = Path('/etc/gitlab-runner/config.toml')
    if target.exists():
        existing = tomllib.loads(target.read_text()).get('runners', [])
        if any(r.get('id') != runners[0].get('id') for r in existing):
            raise ValueError('Other runners exist in system config; merge manually')
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = runtime / ('admin-backup-' + stamp)
    backup.mkdir(parents=True, mode=0o700)
    paths = [target, Path('/etc/systemd/system/recognize-uz.service'),
             Path('/etc/systemd/system/recognize-ru.service')]
    for path in paths:
        if path.is_file():
            shutil.copy2(path, backup / (path.name + '.backup'))
            (backup / (path.name + '.backup')).chmod(0o600)
    for key in ('limit', 'shell', 'environment', 'builds_dir'):
        if runners[0].get(key) is not None:
            raise ValueError('User runner config already has ' + key + '; merge explicitly')
    additions = f'''executor = "shell"
  shell = "bash"
  limit = 1
  builds_dir = "{home}/.local/share/gitlab-runner/builds"
  environment = ["OCR_WHEELHOUSE={home}/.cache/edo-ocr/wheels"]'''
    configuration, count = re.subn(r'executor\s*=\s*"shell"', lambda match: additions, configuration, count=1)
    if count != 1:
        raise ValueError('Shell executor setting not found')
    tomllib.loads(configuration)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(configuration)
    target.chmod(0o600)
    working = home / '.local/share/gitlab-runner'
    working.mkdir(parents=True, exist_ok=True)
    os.chown(working, account.pw_uid, account.pw_gid)
    dropin = Path('/etc/systemd/system/gitlab-runner.service.d/ocr.conf')
    dropin.parent.mkdir(parents=True, exist_ok=True)
    if dropin.exists():
        shutil.copy2(dropin, backup / 'runner-service-override.backup')
    dropin.write_text(f'''[Service]
ExecStart=
ExecStart=/usr/local/bin/gitlab-runner run --config /etc/gitlab-runner/config.toml --working-directory {working} --service gitlab-runner --user {args.user}
''')
    for service in ('uz', 'ru'):
        text = (component / f'deploy/systemd/recognize-{service}.service').read_text()
        text = text.replace('/opt/edo.sps38.pro/ocr', str(runtime / 'current'))
        text = text.replace('User=ocr', 'User=' + args.user).replace('Group=ocr', 'Group=' + args.user)
        text = text.replace('Environment=PYTHONUNBUFFERED=1',
                            f'Environment=PYTHONUNBUFFERED=1\nEnvironment=MODELS_ROOT={runtime}/shared/models')
        Path(f'/etc/systemd/system/recognize-{service}.service').write_text(text)
    control = Path('/usr/local/sbin/edo-ocr-systemctl')
    shutil.copyfile(component / 'deploy/runner/edo-ocr-systemctl', control)
    control.chmod(0o755)
    os.chown(control, 0, 0)
    sudoers = Path('/etc/sudoers.d/edo-ocr')
    if sudoers.exists():
        shutil.copy2(sudoers, backup / 'sudoers.backup')
    sudoers.write_text(f'{args.user} ALL=(root) NOPASSWD: /usr/local/sbin/edo-ocr-systemctl start, /usr/local/sbin/edo-ocr-systemctl stop, /usr/local/sbin/edo-ocr-systemctl restart\n')
    sudoers.chmod(0o440)
    subprocess.run(['visudo', '-cf', str(sudoers)], check=True)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', 'gitlab-runner.service'], check=True)
    subprocess.run(['systemctl', 'restart', 'gitlab-runner.service'], check=True)
    print('Registered runner configured; OCR unit paths installed without restarting APIs')
    print('Private backup: ' + str(backup))


if __name__ == '__main__':
    main()
