# Using a custom transport

Import `connectPortable` and the `PacketTransport` type from `mqtt/portable`. Supply packet send, listener registration and close operations. See [deadlines and forced close](../deadlines.md) for the transport contract. #22 tracks a reader-facing example with cancellation and shutdown.
