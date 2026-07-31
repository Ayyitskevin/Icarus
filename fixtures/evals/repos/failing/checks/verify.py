import sys
from pathlib import Path

# Make the repository root importable, then execute the fixture's own check so
# the evaluator exercises the declared false-value regression in containment.
sys.path.insert(0, str(Path.cwd()))
source = Path("checks/test_parser.py").read_text(encoding="utf-8")
exec(compile(source, "checks/test_parser.py", "exec"))
