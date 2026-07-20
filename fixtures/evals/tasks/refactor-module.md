Extract the duplicated name-normalization algorithm into a new shared module,
then update both `src/format_name.py` and `src/profile.py` to delegate to it
while preserving their public functions and the behavior asserted by the check.
