# Legacy connection option types

The root `connect` entry retains the fork's legacy configuration shape. Its flags, retry interval, storage and acknowledgment options now have explicit types. This typing does not implement reconnect, topic aliases, QoS storage scheduling, custom acknowledgment handling or enhanced authentication. Those features remain tracked separately. Use the documented TCP or browser preview profile for supported operations.

`ConnectOptions`, `LegacyAckHandler`, `LegacyAckCompletion`, `PacketStore` and `PacketIdentifier` are type-only exports from `mqtt`. Custom stores use the structural `PacketStore` interface and need not extend the built-in class. A put operation returns an unspecified result, while get and del return the stored packet. Lookup requests need only its identifier. Mutable packet and error arguments remain mutable.

The legacy WebSocket wrapper exposes its Node Duplex methods and URL metadata. Unused delayed-reader/writer setters and unused socket/config metadata have been removed from its internal interface. The transport does not implement those compatibility methods.
