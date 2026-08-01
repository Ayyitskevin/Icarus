import sys
from pathlib import Path

# Make the repository root importable so the cart module resolves, then run the
# project's own test file so a regression case added there is actually executed.
sys.path.insert(0, str(Path.cwd()))
source = Path("checks/test_cart.py").read_text(encoding="utf-8")
exec(compile(source, "checks/test_cart.py", "exec"))
