"""Verify atomic public model preparation without downloading real weights."""
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import public_models


class PublicModelsTests(unittest.TestCase):
    def setUp(self):
        cache = ROOT / '.cache'
        cache.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=cache)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.revision = 'a' * 40
        self.payload = b'public weight'
        self.manifest = self.root / 'manifest.json'
        self.manifest.write_text(json.dumps({'version': 1,
            'repository': 'google/siglip2-base-patch16-224', 'revision': self.revision,
            'files': [{'path': 'model.safetensors', 'size': len(self.payload),
                       'sha256': hashlib.sha256(self.payload).hexdigest()}]}))
        self.models = self.root / 'models'

    def test_downloads_pinned_revision_and_reuses_verified_files_offline(self):
        calls = []
        def opener(url, timeout):
            calls.append(url)
            return io.BytesIO(self.payload)
        destination = public_models.install(self.manifest, self.models, opener)
        self.assertIn('/resolve/' + self.revision + '/', calls[0])
        self.assertEqual((destination / 'model.safetensors').read_bytes(), self.payload)
        with patch.object(public_models.urllib.request, 'urlopen', side_effect=OSError('offline')):
            public_models.install(self.manifest, self.models, lambda *a, **kw: self.fail('must not fetch again'))

    def test_corrupt_download_never_changes_running_revision_or_promotes_partial(self):
        old = self.models / 'document-check/previous/model.safetensors'
        old.parent.mkdir(parents=True)
        old.write_bytes(b'previous weight')
        with patch.object(public_models.time, 'sleep'), self.assertRaises(ValueError):
            public_models.install(self.manifest, self.models, lambda *a, **kw: io.BytesIO(b'corrupt'))
        self.assertEqual(old.read_bytes(), b'previous weight')
        self.assertFalse((self.models / 'document-check' / self.revision).exists())

    def test_network_failure_preserves_existing_revision(self):
        with patch.object(public_models.time, 'sleep'), self.assertRaises(OSError):
            public_models.install(self.manifest, self.models, lambda *a, **kw: (_ for _ in ()).throw(OSError('offline')))
        self.assertFalse((self.models / 'document-check' / self.revision).exists())
