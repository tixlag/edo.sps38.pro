#!/usr/bin/env python3
"""Deploy a protected main push to the local OCR PC, with release rollback."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.request
import uuid


def run(*args, cwd=None, env=None, capture=False):
    return subprocess.run(args, cwd=cwd, env=env, check=True,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None)


def require_ci_context(env):
    required = {'CI_PROJECT_PATH': 'webdevs/edo.sps38.pro',
                'CI_COMMIT_BRANCH': 'main', 'CI_PIPELINE_SOURCE': 'push',
                'CI_COMMIT_REF_PROTECTED': 'true'}
    if any(env.get(key) != value for key, value in required.items()):
        raise ValueError('Deployment requires a protected main push in webdevs/edo.sps38.pro')


def export_component(repo, commit, destination):
    data = run('git', 'archive', '--format=tar', commit + ':ocr', cwd=repo, capture=True).stdout
    destination.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        archive.extractall(destination, filter='data')


def replace_link(link, target):
    temporary = link.with_name(link.name + '-' + uuid.uuid4().hex)
    temporary.symlink_to(target)
    os.replace(temporary, link)


def activate_release(root, release, control, switch_glm, health):
    current = root / 'current'
    previous = current.resolve() if current.is_symlink() else None
    try:
        control('stop')
        replace_link(current, release)
        switch_glm(release)
        control('start')
        health()
    except Exception as error:
        try:
            control('stop')
            if previous:
                replace_link(current, previous)
                switch_glm(previous)
                control('start')
                health()
            else:
                current.unlink(missing_ok=True)
        except Exception as rollback_error:
            raise RuntimeError('Deployment failed and rollback failed; inspect local services') from rollback_error
        raise RuntimeError('Deployment failed; previous release restored: ' + str(error)) from error


@contextmanager
def cancellation_guard():
    def interrupted(signum, frame):
        raise RuntimeError('Deployment interrupted by signal ' + str(signum))
    previous = {signum: signal.signal(signum, interrupted)
                for signum in (signal.SIGTERM, signal.SIGINT)}
    try:
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def latest_ocr_tree_matches(repo, commit):
    result = run('git', 'ls-remote', 'origin', 'refs/heads/main', cwd=repo, capture=True).stdout.decode().split()
    if not result:
        raise ValueError('Remote main is unavailable')
    latest = result[0]
    if latest == commit:
        return True
    try:
        run('git', 'cat-file', '-e', latest + ':ocr', cwd=repo, capture=True)
    except subprocess.CalledProcessError:
        run('git', 'fetch', '--no-tags', '--depth=1', 'origin', latest, cwd=repo, capture=True)
    own_tree = run('git', 'rev-parse', commit + ':ocr', cwd=repo, capture=True).stdout
    latest_tree = run('git', 'rev-parse', latest + ':ocr', cwd=repo, capture=True).stdout
    return own_tree == latest_tree


def fingerprint(*files):
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.read_bytes())
        digest.update(b'\0')
    return digest.hexdigest()[:24]


@contextmanager
def deployment_lock(root):
    root.mkdir(parents=True, exist_ok=True)
    with (root / 'deploy.lock').open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def check_http(url, timeout, validate=None):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with opener.open(url, timeout=3) as response:
                if response.status == 200 and (validate is None or validate(json.load(response))):
                    return
        except (OSError, ValueError):
            pass
        time.sleep(2)
    raise RuntimeError('Readiness timeout: ' + url)


def services_healthy(root):
    def loaded(data):
        keys = ('doc_model', 'passport_fields_model', 'migration_fields_model',
                'passport_ocr', 'migration_ocr')
        return data.get('status') == 'ok' and all(data.get('models', {}).get(k) is True for k in keys)
    check_http('http://127.0.0.1:8000/health', 120, loaded)
    check_http('http://127.0.0.1:8001/openapi.json', 120,
               lambda data: '/parse' in data.get('paths', {}))
    check_http('http://127.0.0.1:8083/v1/models', 30,
               lambda data: any(m.get('id') == 'zai-org/GLM-OCR' for m in data.get('data', [])))
    import importlib.util
    spec = importlib.util.spec_from_file_location('inference_smoke', Path(__file__).with_name('check_inference.py'))
    smoke = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(smoke)
    private = root / 'shared/var/regression'
    for label, filename, url, document_type in (
            ('UZ', 'uz.jpg', 'http://127.0.0.1:8000/recognize', 'passport'),
            ('migration', 'migration.png', 'http://127.0.0.1:8000/recognize', 'migration_card'),
            ('RU', 'ru.pdf', 'http://127.0.0.1:8001/parse?doc_type=passport_ru', None)):
        status, data = smoke.request(url, private / filename, False, timeout=60)
        if document_type:
            valid = isinstance(data, list) and any(d.get('type') == document_type and d.get('fields') for d in data)
        else:
            valid = isinstance(data, dict) and sum(bool(value) for value in data.get('data', {}).values()) >= 6
        if status != 200 or not valid:
            raise RuntimeError('Real inference check failed: ' + label)
        print('Private inference smoke passed: ' + label)


def prepare_release(repo, commit, root, bootstrap=False):
    release = root / 'releases' / commit
    if (release / 'release.json').is_file():
        # Even a retry must re-check private assets before stopping services.
        run(sys.executable, str(release / 'scripts/models.py'), 'verify',
            '--models-dir', str(root / 'shared/models'))
        return release
    if release.exists():
        shutil.rmtree(release)
    export_component(repo, commit, release)
    shared = root / 'shared'
    for fixture in ('uz.jpg', 'migration.png', 'ru.pdf'):
        if not (shared / 'var/regression' / fixture).is_file():
            raise ValueError('Missing private deployment regression input: ' + fixture)
    run(sys.executable, str(release / 'scripts/models.py'), 'verify',
        '--models-dir', str(shared / 'models'))
    (shared / 'var').mkdir(parents=True, exist_ok=True)
    (release / 'var').symlink_to(shared / 'var')
    vendor_key = fingerprint(release / 'scripts/setup_paddleocr.py',
                             release / 'patches/paddleocr-use-gcu.patch')
    vendor = shared / 'vendor' / vendor_key
    vendor.mkdir(parents=True, exist_ok=True)
    (release / 'vendor').symlink_to(vendor)
    environment_keys = {}
    for service in ('uz', 'ru'):
        service_dir = release / 'services' / service
        key = fingerprint(service_dir / 'requirements.lock', release / 'scripts/setup_service.sh')
        environment_keys[service] = key
        environment = shared / 'venvs' / (service + '-' + key)
        marker = environment / '.ready'
        if not marker.is_file():
            if environment.exists():
                shutil.rmtree(environment)
            env = {**os.environ, 'SERVICE_VENV': str(environment)}
            if os.getenv('OCR_WHEELHOUSE'):
                env['WHEELHOUSE'] = os.environ['OCR_WHEELHOUSE']
            run('bash', str(release / 'scripts/setup_service.sh'), service, env=env)
            marker.write_text(key + '\n')
        (service_dir / '.venv').symlink_to(environment)
        configuration = shared / 'config' / (service + '.env')
        if configuration.exists():
            (service_dir / '.env').symlink_to(configuration)
    run(sys.executable, str(release / 'scripts/setup_paddleocr.py'))
    glm_key = fingerprint(release / 'deploy/glm/Dockerfile', release / 'deploy/glm/compose.yaml')
    glm_dir = shared / 'glm' / glm_key
    glm_dir.mkdir(parents=True, exist_ok=True)
    for name in ('Dockerfile', 'compose.yaml'):
        shutil.copy2(release / 'deploy/glm' / name, glm_dir / name)
    image = 'document-ocr-glm:' + fingerprint(glm_dir / 'Dockerfile')
    if bootstrap:
        # Reuse the exact tested image; do not silently upgrade on first setup.
        existing = run('docker', 'inspect', '--format', '{{.Image}}', 'glm-ocr-vllm', capture=True).stdout.decode().strip()
        run('docker', 'tag', existing, image)
    else:
        try:
            run('docker', 'image', 'inspect', image, capture=True)
        except subprocess.CalledProcessError:
            run('docker', 'compose', '-p', 'edo-ocr', '-f', str(glm_dir / 'compose.yaml'),
                'build', env={**os.environ, 'GLM_OCR_IMAGE': image})
    (release / 'release.json').write_text(json.dumps({'commit': commit, 'glm_key': glm_key,
                                                    'glm_image': image, 'environments': environment_keys}, indent=2))
    return release


def switch_glm(root, release):
    metadata = json.loads((release / 'release.json').read_text())
    configuration = root / 'shared/glm' / metadata['glm_key'] / 'compose.yaml'
    # Stable content-addressed compose path avoids recreating GLM on code-only pushes.
    run('docker', 'compose', '-p', 'edo-ocr', '-f', str(configuration), 'up', '-d', '--no-build',
        env={**os.environ, 'GLM_OCR_IMAGE': metadata['glm_image']})
    check_http('http://127.0.0.1:8083/v1/models', 300,
               lambda data: any(m.get('id') == 'zai-org/GLM-OCR' for m in data.get('data', [])))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--root', type=Path, default=Path.home() / '.local/share/edo-ocr')
    parser.add_argument('--bootstrap', action='store_true', help='one-time local setup; forbidden in GitLab CI')
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    if args.bootstrap:
        if os.getenv('GITLAB_CI') == 'true':
            raise ValueError('Bootstrap is not permitted in CI')
    else:
        require_ci_context(os.environ)
    repo = args.repo.resolve()
    commit = run('git', 'rev-parse', 'HEAD', cwd=repo, capture=True).stdout.decode().strip()
    if not args.bootstrap and commit != os.getenv('CI_COMMIT_SHA'):
        raise ValueError('Checkout does not match CI_COMMIT_SHA')
    root = args.root.expanduser().resolve()
    with cancellation_guard(), deployment_lock(root):
        if not args.bootstrap:
            if not latest_ocr_tree_matches(repo, commit):
                print('A newer OCR version exists on main; skipping outdated deployment')
                return
        release = prepare_release(repo, commit, root, args.bootstrap)
        if args.prepare_only:
            print('Prepared release: ' + commit)
            return
        if not args.bootstrap and not latest_ocr_tree_matches(repo, commit):
            print('OCR changed on main during preparation; skipping outdated deployment')
            return
        control = lambda action: run('sudo', '-n', '/usr/local/sbin/edo-ocr-systemctl', action)
        activate_release(root, release, control, lambda version: switch_glm(root, version), lambda: services_healthy(root))
        # Only a successful health check records a deployed commit.
        (root / 'deployed.json').write_text(json.dumps({'commit': commit, 'pipeline': os.getenv('CI_PIPELINE_URL'),
                                                      'deployed_at': time.time(), 'real_inference_verified': True}, indent=2))
        print('OCR deployed successfully: ' + commit)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print('OCR deployment failed: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
