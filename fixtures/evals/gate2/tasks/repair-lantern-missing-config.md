# Repair: missing Lantern configuration

Return a bounded configuration error when `config/app.json` is absent instead
of exposing a raw filesystem exception.
