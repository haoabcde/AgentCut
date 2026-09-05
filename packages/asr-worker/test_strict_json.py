import json
import math
import unittest

from strict_json import sanitize_for_json


class StrictJsonTest(unittest.TestCase):
    def test_replaces_nested_non_finite_provider_values(self) -> None:
        sanitized = sanitize_for_json({
            "avg_logprob": math.nan,
            "scores": [1.0, math.inf, -math.inf],
            "nested": ({"value": 2.0},),
        })
        self.assertEqual(sanitized, {
            "avg_logprob": None,
            "scores": [1.0, None, None],
            "nested": [{"value": 2.0}],
        })
        self.assertNotIn("NaN", json.dumps(sanitized, allow_nan=False))


if __name__ == "__main__":
    unittest.main()
