import unittest
from datetime import date
from review import review_window, summarize, timestamp


class ReviewTest(unittest.TestCase):
    def test_window_boundaries_and_year_rollover(self):
        start, end = review_window(date(2026, 1, 2))
        self.assertEqual(start.isoformat(), '2025-12-31T08:00:00+08:00')
        self.assertEqual(end.isoformat(), '2026-01-01T08:00:00+08:00')
        self.assertTrue(start <= timestamp('2025-12-31T00:00:00Z') < end)
        self.assertFalse(start <= timestamp('2026-01-01T00:00:00Z') < end)

    def test_missing_is_not_zero(self):
        posts = [{'metrics': dict.fromkeys(('views', 'likes', 'replies', 'reposts', 'bookmarks'))}]
        result = summarize(posts)
        self.assertIsNone(result['metrics']['views']['sum'])
        self.assertEqual(result['zeroReposts'], 0)
        posts[0]['metrics']['reposts'] = 0
        self.assertEqual(summarize(posts)['metrics']['reposts']['sum'], 0)
        self.assertEqual(summarize(posts)['zeroReposts'], 1)


if __name__ == '__main__':
    unittest.main()
