from pathlib import Path


def read_public(root: Path, user_path: str) -> str:
    return (root / user_path).read_text(encoding="utf8")
