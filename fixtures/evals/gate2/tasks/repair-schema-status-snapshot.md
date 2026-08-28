# Repair: task status schema snapshot

Add a non-null task status with a safe default to the offline schema snapshot
and update the existing contract query to select it. Do not create a migration,
connect to a database, or mutate database state outside the disposable check.
