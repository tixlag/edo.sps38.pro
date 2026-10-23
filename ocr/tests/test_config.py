import importlib
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/uz'))


class PortableConfigTests(unittest.TestCase):
    def config(self):
        import recognizeuz.core.config as config
        return importlib.reload(config)

    def test_migration_cards_enabled(self):
        self.assertEqual(self.config().ALLOWED_DOC_TYPES, {'passport', 'migration_card'})

    def test_default_models_belong_to_export(self):
        config = self.config()
        self.assertEqual(config.PROJECT_ROOT, ROOT)
        self.assertEqual(config.DOC_MODEL_PATH, ROOT / 'models/uz/doc_detector.pt')
        self.assertEqual(config.PASSPORT_DICT_PATH, ROOT / 'models/uz/passport_ocr/dict.txt')

    def test_external_paths_can_be_configured(self):
        with patch.dict(os.environ, {'DOC_MODEL_PATH': '/tmp/custom.pt', 'USE_GPU': '0', 'DEVICE': '2'}):
            config = self.config()
            self.assertEqual(config.DOC_MODEL_PATH, Path('/tmp/custom.pt'))
            self.assertFalse(config.USE_GPU)
            self.assertEqual(config.DEVICE, 2)
        self.config()


if __name__ == '__main__':
    unittest.main()
