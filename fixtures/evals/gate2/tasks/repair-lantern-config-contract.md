# Repair: missing Lantern configuration contract

When `config/app.json` is absent, the entry point must exit with status 1, print
nothing to stdout, and print exactly the line `Lantern configuration is unavailable.`
to stderr, instead of exposing a raw filesystem exception. The present-config
behavior is unchanged.
