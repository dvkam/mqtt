# Legacy in-memory store

The inherited Store applies `clean: true` by default. Closing a default or explicitly clean store rejects subsequent put, get, delete and snapshot operations with `Store is closed`. Repeated close is harmless. An explicit `clean: false` keeps the store usable and preserves the stored packet objects.

A snapshot captures the entries present when its stream is created. Packet objects and their payloads retain their identity. A snapshot created before clean close can still finish reading those entries. Closing the store does not cancel an existing snapshot.

The source tests cover default and explicit close policies, asynchronous rejection, packet identity and snapshot behavior. The two default-policy cases fail on the old constructor because it nests its defaults instead of applying them. Copying the Map's values directly preserves the snapshot while removing the callback-specific lint suppression.

This is the legacy in-memory implementation. #14 owns durable session storage, and #27 tracks native stream cleanup.
