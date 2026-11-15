# Using a custom transport

Import `connectPortable` and the `PacketTransport` type from `mqtt/portable`, and `encodePacket` and `PacketDecoder` from `mqtt/codec`. Supply packet send, listener registration and close operations. The transport sends and receives the codec's packets, so it needs no translation layer. [Public client types](../public-types.md#custom-transport-contract) has the contract and an example. See [deadlines and forced close](../deadlines.md) for the close rules. #22 tracks a reader-facing example with cancellation and shutdown.
