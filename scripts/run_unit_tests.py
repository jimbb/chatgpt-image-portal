from pathlib import Path
import subprocess
import sys

EXCLUDED = {
    "test_gpt_4k.py", "test_gpt_ppt.py", "test_gpt_psd.py", "test_gpt_search.py",
    "test_image_output_tokens.py", "test_v1_messages.py", "test_v1_images_edits.py",
    "test_v1_images_generations.py", "test_v1_images_edits.py", "test_v1_images_edits_api.py", "test_v1_images_edits_json.py", "test_v1_models.py", "test_v1_responses.py",
}
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
import unittest

loader = unittest.defaultTestLoader
suite = unittest.TestSuite()
for path in sorted((root / "test").glob("test_*.py")):
    if path.name not in EXCLUDED:
        suite.addTests(loader.loadTestsFromName(f"test.{path.stem}"))
raise SystemExit(unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful() is False)
