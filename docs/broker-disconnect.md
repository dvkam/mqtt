# Broker disconnect outcomes

The shared session treats a delivered broker DISCONNECT as terminal. Pending work and later calls receive an Error with message `MQTT broker disconnected` and numeric `code`. An omitted reason becomes zero. Earlier terminal failures retain precedence. The client requests forced closure without sending a reply DISCONNECT. A local disconnect already requested retains its existing closing checks.

Node adapters retain the reason supplied by mqtt-packet. The browser codec accepts normal DISCONNECT and reasons 0x81, 0x82 and 0x93 with no properties. The browser adapter passes those codes through. Other reasons and DISCONNECT properties remain outside the codec profile.

The browser decoder parses a whole input batch before delivering packets. A malformed suffix can prevent an earlier DISCONNECT in that batch from reaching the session. Node parsing delivers packets incrementally. This change preserves first delivered terminal cause; it does not promise identical first-wire-event precedence across those decoders. Valid application packets delivered after retirement are ignored.

The implementation follows the close recommendation in MQTT 5 section 3.14.4. Reason/property validation and broader direction checks remain under #9 and #16. See the [MQTT 5 specification](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html).
