# Refactor: cart subtotal helper

Extract the subtotal arithmetic out of the cart module into a new `money`
module beside it. Keep `subtotal` in the cart module as the public API,
delegating to the extracted helper, and preserve its tests.
