from src.parser import parse_enabled

assert parse_enabled("true") is True
assert parse_enabled("false") is False
