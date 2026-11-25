# Broker disconnect outcomes

The shared session treats a delivered broker DISCONNECT as terminal. Pending work and later calls receive an `MqttError` with code `ERR_MQTT_BROKER_DISCONNECT` and the numeric `reasonCode`. An omitted reason becomes zero. The error also carries the broker's `reasonString` and `userProperties` when present. See [error codes](errors.md). Earlier terminal failures retain precedence. The client requests forced closure without sending a reply DISCONNECT. A local disconnect already requested retains its existing closing checks.

Node adapters retain the reason supplied by mqtt-packet. Update, 16 November 2026: the Node adapters have decoded with the in-repository codec since #165, and mqtt-packet has been a development dependency since #170. Both platforms accept every DISCONNECT reason code and its properties since #162. The browser codec accepts normal DISCONNECT and reasons 0x81, 0x82 and 0x93 with no properties. The browser adapter passes those codes through. Other reasons and DISCONNECT properties remain outside the codec profile.

The browser decoder parses a whole input batch before delivering packets. A malformed suffix can prevent an earlier DISCONNECT in that batch from reaching the session. Node parsing delivers packets incrementally. This change preserves first delivered terminal cause; it does not promise identical first-wire-event precedence across those decoders. Valid application packets delivered after retirement are ignored.

The implementation follows the close recommendation in MQTT 5 section 3.14.4. Reason/property validation and broader direction checks remain under #9 and #16. See the [MQTT 5 specification](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html).
