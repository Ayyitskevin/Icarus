# Refactor fixture

Name normalization is duplicated across two modules. A behavior-preserving
refactor must extract a shared implementation, update both public modules, and
retain the check.
