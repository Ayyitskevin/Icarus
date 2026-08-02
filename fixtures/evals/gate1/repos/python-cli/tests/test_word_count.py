"""Behavioral tests for the word-count CLI."""

from contextlib import redirect_stdout
from io import StringIO
import unittest

from src.word_count import count_words, main


class WordCountTests(unittest.TestCase):
    def test_counts_mixed_unicode_whitespace(self) -> None:
        self.assertEqual(count_words("alpha\tbeta\ngamma\u2003delta"), 4)

    def test_ignores_surrounding_whitespace(self) -> None:
        self.assertEqual(count_words("  alpha beta  "), 2)

    def test_empty_and_whitespace_only_input(self) -> None:
        self.assertEqual(count_words(""), 0)
        self.assertEqual(count_words(" \t\n\u2003"), 0)

    def test_cli_prints_the_count(self) -> None:
        output = StringIO()
        with redirect_stdout(output):
            result = main(["red\nblue"])

        self.assertEqual(result, 0)
        self.assertEqual(output.getvalue(), "2\n")


if __name__ == "__main__":
    unittest.main()
