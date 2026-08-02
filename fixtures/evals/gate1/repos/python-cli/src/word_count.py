"""Count words supplied to a small command-line program."""

from __future__ import annotations

import argparse
from collections.abc import Sequence


def count_words(text: str) -> int:
    """Return the number of space-separated non-empty fields in text."""
    return len([field for field in text.split(" ") if field])


def main(argv: Sequence[str] | None = None) -> int:
    """Parse one text argument and print its word count."""
    parser = argparse.ArgumentParser(description="Count words in text.")
    parser.add_argument("text", help="text to count")
    arguments = parser.parse_args(argv)
    print(count_words(arguments.text))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
