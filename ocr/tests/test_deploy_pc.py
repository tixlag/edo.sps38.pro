"""Deployment must preserve the running release when promotion fails."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/deploy_pc.py'


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), 'deploy_pc.py is not implemented')
        spec = importlib.util.spec_from_file_location('deploy_pc', SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.old = self.root / 'releases/old'
        self.new = self.root / 'releases/new'
        for release in (self.old, self.new):
            release.mkdir(parents=True)
        (self.old / 'code.txt').write_text('old code')
        (self.new / 'code.txt').write_text('new code')
        (self.root / 'current').symlink_to(self.old)
        (self.root / 'models').mkdir()
        (self.root / 'models/private.pt').write_bytes(b'private model')

    def test_success_promotes_release_without_replacing_private_assets(self):
        self.module.activate_release(self.root, self.new, lambda action: None,
                                     lambda release: None, lambda: None)
        self.assertEqual((self.root / 'current/code.txt').read_text(), 'new code')
        self.assertEqual((self.old / 'code.txt').read_text(), 'old code')
        self.assertEqual((self.root / 'models/private.pt').read_bytes(), b'private model')

    def test_public_model_preparation_failure_keeps_the_running_release(self):
        (self.new / 'models').mkdir()
        (self.new / 'models/public-manifest.json').write_text('{}')
        with patch.object(self.module, 'run', side_effect=RuntimeError('network unavailable')) as run:
            with self.assertRaisesRegex(RuntimeError, 'network unavailable'):
                self.module.prepare_classifier(self.new, self.root / 'shared')
        self.assertIn('public_models.py', run.call_args.args[1])
        self.assertEqual((self.root / 'current').resolve(), self.old)

    def test_old_release_does_not_require_a_classifier_during_rollback(self):
        with patch.object(self.module, 'run') as run:
            self.module.prepare_classifier(self.old, self.root / 'shared')
        run.assert_not_called()

    def test_failed_health_restores_previous_release_and_propagates_failure(self):
        def health():
            if (self.root / 'current').resolve() == self.new:
                raise RuntimeError('new release did not become healthy')
        with self.assertRaisesRegex(RuntimeError, 'new release'):
            self.module.activate_release(self.root, self.new, lambda action: None,
                                         lambda release: None, health)
        self.assertEqual((self.root / 'current/code.txt').read_text(), 'old code')
        self.assertEqual((self.root / 'models/private.pt').read_bytes(), b'private model')

    def test_failed_glm_update_also_rolls_back_code(self):
        def glm(release):
            if release == self.new:
                raise RuntimeError('GLM update failed')
        with self.assertRaisesRegex(RuntimeError, 'GLM update'):
            self.module.activate_release(self.root, self.new, lambda action: None,
                                         glm, lambda: None)
        self.assertEqual((self.root / 'current').resolve(), self.old)

    def test_rollback_failure_is_reported_instead_of_success(self):
        def health():
            raise RuntimeError('health failed')
        with self.assertRaisesRegex(RuntimeError, 'rollback'):
            self.module.activate_release(self.root, self.new, lambda action: None,
                                         lambda release: None, health)
        self.assertEqual((self.root / 'current').resolve(), self.old)

    def test_partial_stop_failure_recovers_the_previous_service(self):
        state = self.root / 'service-state'
        state.write_text('running')
        failed = False
        def control(action):
            nonlocal failed
            state.write_text('running' if action == 'start' else 'stopped')
            if action == 'stop' and not failed:
                failed = True
                raise RuntimeError('partial stop failed')
        with self.assertRaisesRegex(RuntimeError, 'partial stop'):
            self.module.activate_release(self.root, self.new, control,
                                         lambda release: None, lambda: None)
        self.assertEqual(state.read_text(), 'running')
        self.assertEqual((self.root / 'current').resolve(), self.old)

    def test_sigterm_during_promotion_restores_previous_release(self):
        code = """import importlib.util,os,signal,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('deploy',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
root=Path(sys.argv[2]);new=root/'releases/new'
def health():
    if (root/'current').resolve()==new:os.kill(os.getpid(),signal.SIGTERM)
try:
    with module.cancellation_guard():
        module.activate_release(root,new,lambda action:None,lambda release:None,health)
except RuntimeError:
    sys.exit(7)
"""
        import sys
        result = subprocess.run([sys.executable, '-c', code, str(SCRIPT), str(self.root)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertEqual((self.root / 'current').resolve(), self.old)

    def test_non_ocr_successor_keeps_deploy_but_ocr_successor_supersedes_it(self):
        repo = self.root / 'source'
        remote = self.root / 'remote.git'
        subprocess.run(['git', 'init', '-q', '-b', 'main', str(repo)], check=True)
        subprocess.run(['git', 'init', '-q', '--bare', str(remote)], check=True)
        def git(*args):
            return subprocess.check_output(['git', '-C', str(repo), '-c', 'user.name=Test',
                                            '-c', 'user.email=test@example.test', *args]).decode().strip()
        (repo / 'ocr').mkdir()
        (repo / 'ocr/code.py').write_text('VERSION=1')
        git('add', '.');git('commit', '-qm', 'OCR A')
        first = git('rev-parse', 'HEAD')
        git('remote', 'add', 'origin', str(remote));git('push', '-q', 'origin', 'main')
        self.assertTrue(self.module.latest_ocr_tree_matches(repo, first))
        (repo / 'edo.txt').write_text('non OCR B')
        git('add', '.');git('commit', '-qm', 'EDO B');git('push', '-q', 'origin', 'main')
        self.assertTrue(self.module.latest_ocr_tree_matches(repo, first))
        (repo / 'ocr/code.py').write_text('VERSION=2')
        git('add', '.');git('commit', '-qm', 'OCR C');git('push', '-q', 'origin', 'main')
        self.assertFalse(self.module.latest_ocr_tree_matches(repo, first))

    def test_host_setup_rejects_missing_baseline_before_modifying_services(self):
        installer = SCRIPT.parents[1] / 'deploy/runner/install_host.py'
        spec = importlib.util.spec_from_file_location('install_host', installer)
        module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        self.assertTrue(hasattr(module, 'validate_baseline'))
        with self.assertRaises(ValueError):
            module.validate_baseline(self.root)
        self.assertEqual((self.root / 'current').resolve(), self.old)

    def test_cached_release_still_requires_private_acceptance_inputs(self):
        cached = self.root / 'releases/cached'
        cached.mkdir()
        (cached / 'release.json').write_text('{}')
        import hashlib,json,shutil
        (cached / 'scripts').mkdir();(cached / 'models').mkdir()
        shutil.copy2(SCRIPT.with_name('models.py'),cached / 'scripts/models.py')
        models=self.root / 'shared/models';models.mkdir(parents=True)
        (models / 'model.txt').write_bytes(b'weight')
        (cached / 'models/manifest.json').write_text(json.dumps({'version':1,'files':[
            {'path':'model.txt','size':6,'sha256':hashlib.sha256(b'weight').hexdigest()}]}))
        with self.assertRaisesRegex(ValueError, 'Missing private deployment regression input'):
            self.module.prepare_release(self.root, 'cached', self.root)
        self.assertEqual((self.root / 'current').resolve(), self.old)

    def test_only_protected_main_push_in_correct_project_is_accepted(self):
        valid = {'CI_PROJECT_PATH': 'webdevs/edo.sps38.pro',
                 'CI_COMMIT_BRANCH': 'main', 'CI_PIPELINE_SOURCE': 'push',
                 'CI_COMMIT_REF_PROTECTED': 'true'}
        self.module.require_ci_context(valid)
        for key, wrong in [('CI_PROJECT_PATH', 'other/project'),
                           ('CI_COMMIT_BRANCH', 'feature/test'),
                           ('CI_PIPELINE_SOURCE', 'merge_request_event'),
                           ('CI_COMMIT_REF_PROTECTED', 'false')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.module.require_ci_context({**valid, key: wrong})

    def test_export_contains_committed_component_only(self):
        repo = self.root / 'repo'
        subprocess.run(['git', 'init', '-q', '-b', 'main', str(repo)], check=True)
        (repo / 'ocr').mkdir()
        (repo / 'ocr/code.py').write_text('VALUE = 1\n')
        (repo / 'unrelated.txt').write_text('EDO')
        subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Test', '-c',
                        'user.email=test@example.test', 'commit', '-qm', 'fixture'], check=True)
        (repo / 'ocr/.env').write_text('PRIVATE=not-for-release')
        (repo / 'ocr/code.py').write_text('UNCOMMITTED = 2\n')
        destination = self.root / 'export'
        self.module.export_component(repo, 'HEAD', destination)
        self.assertEqual((destination / 'code.py').read_text(), 'VALUE = 1\n')
        self.assertFalse((destination / '.env').exists())
        self.assertFalse((destination / 'unrelated.txt').exists())


if __name__ == '__main__':
    unittest.main()
