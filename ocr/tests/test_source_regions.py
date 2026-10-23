"""Runner-only geometry checks; stdlib, no models or inference imports."""
from math import isfinite
import unittest

from test_ocr_provenance import ROOT, load_functions


class SourceRegionTests(unittest.TestCase):
    def setUp(self):
        self.ru = load_functions(ROOT / 'services/ru/doc_recognizer_universe.py',
                                 ['_source_box_region'], {})['_source_box_region']
        self.uz = load_functions(ROOT / 'services/uz/recognizeuz/image/geometry.py',
                                 ['source_polygon_region'], {'isfinite': isfinite})['source_polygon_region']

    def assert_region(self, actual, expected):
        self.assertIsNotNone(actual)
        for key, value in zip(('x', 'y', 'width', 'height'), expected):
            self.assertAlmostEqual(actual[key], value, places=6)

    def test_ru_rotations_return_same_source_box(self):
        # Original image 200x100, source box (20,10)..(80,30).
        for angle, box in [(0, (20, 10, 80, 30)), (90, (70, 20, 90, 80)),
                           (180, (120, 70, 180, 90)), (270, (10, 120, 30, 180))]:
            with self.subTest(angle=angle):
                self.assert_region(self.ru(box, (100, 200), angle), (0.1, 0.1, 0.3, 0.2))

    def test_ru_embedded_image_placement_and_rotated_pdf_page(self):
        self.assert_region(self.ru((0.1, 0.2, 0.4, 0.3), (1, 1),
                                  page_transform=[0.6, 0, 0, 0.8, 0.2, 0.1]),
                           (0.26, 0.26, 0.18, 0.08))
        self.assert_region(self.ru((0.1, 0.2, 0.4, 0.3), (1, 1),
                                  page_transform=[0, 0.6, -0.8, 0, 0.9, 0.2]),
                           (0.66, 0.26, 0.08, 0.18))

    def test_uz_inverse_orientation_then_perspective(self):
        inverse = [[2, 0, 100], [0, 2, 50], [0, 0, 1]]
        original = [(20, 10), (80, 10), (80, 30), (20, 30)]
        for angle in (0, 90, 180, 270):
            points = []
            for x, y in original:
                points.append({0: (x, y), 90: (99 - y, x),
                               180: (199 - x, 99 - y), 270: (y, 199 - x)}[angle])
            with self.subTest(angle=angle):
                self.assert_region(self.uz(points, inverse, (500, 1000), (100, 200), angle),
                                   (0.14, 0.14, 0.12, 0.08))

    def test_uz_non_affine_perspective_and_invalid_geometry(self):
        points = [(0, 0), (100, 0), (100, 100), (0, 100)]
        self.assert_region(self.uz(points, [[1, 0, 0], [0, 1, 0], [0.01, 0, 1]],
                                   (100, 100), (100, 100)), (0, 0, 0.5, 1))
        for invalid in ([], [(0, 0)] * 4):
            self.assertIsNone(self.uz(invalid, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], (100, 100), (100, 100)))
        self.assertIsNone(self.uz(points, [[1, 0, 0], [0, 1, 0], [0, 0, 0]], (100, 100), (100, 100)))


if __name__ == '__main__':
    unittest.main()
