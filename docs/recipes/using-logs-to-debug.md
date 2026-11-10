# Packet and session diagnostics

The supported client factories and the experimental portable client accept an optional `onDiagnostic` callback. Package imports and default sessions emit no fork diagnostics.

```ts
import { createTcpClient } from 'mqtt';
import { pino } from 'pino';

const logger = pino({ level: 'debug' });
const client = await createTcpClient({
  host: 'localhost',
  clientId: 'example',
  onDiagnostic(event) {
    logger.debug(event);
  },
}).connect();
```

The callback receives only two event shapes.

- A packet event names the inbound or outbound direction and the MQTT command.
- A connection event reports when the MQTT session becomes active or retires.

An outbound event records a transport call that returned. A synchronous throw reaches the session without invoking the observer. Use the operation result to check local completion or a broker acknowledgment. A synchronous custom transport may deliver a response before the outbound call returns. An inbound event records a packet whose synchronous dispatch returned. Opening failures before MQTT starts use the connection promise.

The callback runs in the calling turn. The client ignores callback exceptions and rejected promises. The caller owns any work it starts in the observer. The connection attempt checks for retirement triggered during the active callback. Diagnostic events contain no packet contents, endpoint strings or error objects.

This option is independent of a dependency's verbose debug output. The retained mqtt-packet dependency has debug namespaces that can include packet fields and payloads if enabled. [mqtt-packet generator](https://github.com/mqttjs/mqtt-packet/blob/dd17095bbe52ac28bc96c831e69b0db4371da5a5/writeToStream.js)
