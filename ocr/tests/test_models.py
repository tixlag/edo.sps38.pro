"""Installer must reject bad archives before writing any model files."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ModelArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.destination = self.base / 'installed'
        self.manifest = self.base / 'manifest.json'
        self.payload = {'uz/model.pt': b'model-bytes', 'ru/dict.txt': b'abc'}
        self.manifest.write_text(json.dumps({'version': 1, 'files': [
            {'path': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
            for name, data in self.payload.items()
        ]}))

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(ROOT / 'scripts/models.py'),
            '--manifest', str(self.manifest), *map(str, args), '--models-dir', str(self.destination)],
            capture_output=True, text=True)

    def archive(self, payload=None, extra=None):
        path = self.base / 'models.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, data in (self.payload if payload is None else payload).items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            if extra is not None:
                archive.addfile(extra)
        return path

    def test_install_and_verify(self):
        result = self.run_cli('install', self.archive())
        self.assertEqual(result.returncode, 0, result.stderr)
        for name, data in self.payload.items():
            self.assertEqual((self.destination / name).read_bytes(), data)
        self.assertEqual(self.run_cli('verify').returncode, 0)

    def test_corruption_does_not_replace_existing_files(self):
        existing = self.destination / 'uz/model.pt'
        existing.parent.mkdir(parents=True)
        existing.write_bytes(b'existing')
        bad = dict(self.payload, **{'ru/dict.txt': b'bad'})
        self.assertNotEqual(self.run_cli('install', self.archive(bad)).returncode, 0)
        self.assertEqual(existing.read_bytes(), b'existing')
        self.assertFalse((self.destination / 'ru/dict.txt').exists())

    def test_missing_member(self):
        self.assertNotEqual(self.run_cli('install', self.archive({'ru/dict.txt': b'abc'})).returncode, 0)

    def test_traversal_rejected(self):
        result = self.run_cli('install', self.archive(extra=tarfile.TarInfo('../outside')))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.base / 'outside').exists())

    def test_symlink_rejected(self):
        info = tarfile.TarInfo('link')
        info.type = tarfile.SYMTYPE
        info.linkname = '/tmp'
        self.assertNotEqual(self.run_cli('install', self.archive(extra=info)).returncode, 0)

    def test_verify_detects_missing_and_corrupted_files(self):
        self.assertNotEqual(self.run_cli('verify').returncode, 0)
        installed = self.run_cli('install', self.archive())
        self.assertEqual(installed.returncode, 0, installed.stderr)
        (self.destination / 'ru/dict.txt').write_bytes(b'bad')
        self.assertNotEqual(self.run_cli('verify').returncode, 0)

    def test_pack_roundtrip(self):
        result = self.run_cli('install', self.archive())
        self.assertEqual(result.returncode, 0, result.stderr)
        packed = self.base / 'repacked.tar.gz'
        self.assertEqual(self.run_cli('pack', packed).returncode, 0)
        self.assertTrue(packed.is_file())


if __name__ == '__main__':
    unittest.main()
