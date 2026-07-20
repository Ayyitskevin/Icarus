from src.format_name import format_name
from src.profile import display_name

assert format_name("  ada   lovelace ") == display_name("  ada   lovelace ") == "Ada Lovelace"
