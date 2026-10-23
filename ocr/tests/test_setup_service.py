"""Dependency installation must respect a persistent environment destination."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/setup_service.sh'


class SetupServiceTests(unittest.TestCase):
    def test_install_environment_outside_release_without_downloading_packages(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / 'release'
            (project / 'scripts').mkdir(parents=True)
            (project / 'services/ru').mkdir(parents=True)
            (project / 'services/ru/requirements.lock').write_text('')
            script = project / 'scripts/setup_service.sh'
            shutil.copy2(SOURCE, script)
            wheels = root / 'wheels'
            wheels.mkdir()
            environment = root / 'persistent-environment'
            result = subprocess.run(['bash', str(script), 'ru'], capture_output=True, text=True,
                                    env={**os.environ, 'SERVICE_VENV': str(environment),
                                         'PYTHON': '/usr/bin/python3.12', 'WHEELHOUSE': str(wheels)})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((environment / 'bin/python').is_file())
            self.assertFalse((project / 'services/ru/.venv').exists())
