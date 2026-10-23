"""Offline regressions for screenshot encoding negotiation in control.py."""
import importlib.machinery
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch


def load_control():
    loader = importlib.machinery.SourceFileLoader("control_observation", str(Path(__file__).with_name("control.py")))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


control = load_control()


class ObservationFormatTest(unittest.TestCase):
    def test_defaults_to_png_for_old_and_unknown_requests(self):
        self.assertEqual(control.observation_format({}), ("png", None))
        self.assertEqual(control.observation_format({"imageFormat": "webp"}), ("png", None))

    def test_accepts_jpeg_with_bounded_quality(self):
        self.assertEqual(control.observation_format({"imageFormat": "jpeg", "jpegQuality": 70}), ("jpeg", 70))
        self.assertEqual(control.observation_format({"imageFormat": "jpeg", "jpegQuality": 5}), ("jpeg", 80))
        self.assertEqual(control.observation_format({"imageFormat": "jpeg", "jpegQuality": "90"}), ("jpeg", 80))
        self.assertEqual(control.observation_format({"imageFormat": "jpeg", "jpegQuality": True}), ("jpeg", 80))

    def test_encode_jpeg_returns_converted_bytes(self):
        result = subprocess.CompletedProcess([], 0, b"\xff\xd8jpeg", b"")
        with patch.object(control.subprocess, "run", return_value=result) as run:
            self.assertEqual(control.encode_jpeg(b"png", 75, {}), b"\xff\xd8jpeg")
        argv = run.call_args.args[0]
        self.assertEqual(argv[0], "convert")
        self.assertIn("75", argv)
        self.assertEqual(argv[-1], "jpeg:-")

    def test_encode_jpeg_keeps_png_when_conversion_fails(self):
        failed = subprocess.CompletedProcess([], 1, b"", b"boom")
        with patch.object(control.subprocess, "run", return_value=failed):
            self.assertIsNone(control.encode_jpeg(b"png", 75, {}))
        not_jpeg = subprocess.CompletedProcess([], 0, b"\x89PNG", b"")
        with patch.object(control.subprocess, "run", return_value=not_jpeg):
            self.assertIsNone(control.encode_jpeg(b"png", 75, {}))
        with patch.object(control.subprocess, "run", side_effect=FileNotFoundError()):
            self.assertIsNone(control.encode_jpeg(b"png", 75, {}))


if __name__ == "__main__":
    unittest.main()
