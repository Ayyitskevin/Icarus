from pathlib import Path

assert Path("src/greeting.txt").read_text(encoding="utf-8") == "Hello, Icarus!\n"
