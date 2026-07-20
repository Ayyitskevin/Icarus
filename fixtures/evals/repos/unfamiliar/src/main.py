import json
from pathlib import Path

from src.greeting import greeting

print(greeting(json.loads(Path("config/app.json").read_text())["audience"]))
