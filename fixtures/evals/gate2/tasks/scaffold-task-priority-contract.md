# Scaffold: task priority contract

Add a non-null task priority with a safe default to the offline schema snapshot
and create a separate read-only contract query for it. Do not create a migration,
connect to a database, or mutate database state outside the disposable check.
