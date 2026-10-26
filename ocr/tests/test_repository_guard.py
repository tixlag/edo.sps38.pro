"""The staged-file guard must work both standalone and under EDO/ocr."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/check_repository.py'


class RepositoryGuardTests(unittest.TestCase):
    def prepare(self, nested):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        repo = Path(temporary.name)
        subprocess.run(['git','init','-q',str(repo)],check=True)
        component = repo / 'ocr' if nested else repo
        script = component / 'scripts/check_repository.py'
        script.parent.mkdir(parents=True)
        shutil.copy2(SOURCE,script)
        (component / 'README.md').write_text('OCR source')
        return repo,component,script

    def run_guard(self, repo, script):
        subprocess.run(['git','-C',str(repo),'add','.'],check=True)
        return subprocess.run([sys.executable,str(script)],capture_output=True,text=True)

    def test_nested_guard_reads_component_blobs_and_ignores_parent_files(self):
        repo,component,script = self.prepare(nested=True)
        (repo / 'README.md').write_text('hf_' + 'x' * 30)
        (repo / 'image.png').write_bytes(b'Existing EDO artifact')
        result = self.run_guard(repo,script)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_nested_guard_detects_secret_in_component_blob(self):
        repo,component,script = self.prepare(nested=True)
        (repo / 'README.md').write_text('EDO source')
        (component / 'README.md').write_text('hf_' + 'x' * 30)
        result = self.run_guard(repo,script)
        self.assertNotEqual(result.returncode,0,result.stdout)
        self.assertIn('Possible credential',result.stderr)

    def test_standalone_guard_still_works(self):
        repo,component,script = self.prepare(nested=False)
        result = self.run_guard(repo,script)
        self.assertEqual(result.returncode,0,result.stderr)
