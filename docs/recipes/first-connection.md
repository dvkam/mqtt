# First connection and recovery

Install the preview tarball in an ESM project. Start the local broker and run the TCP or browser echo from the README. The echo uses one client, one topic, and a five-second wait. [Install and echo examples](../../README.md#try-the-preview) · [Local broker](../running-the-sample.md)

| What happens | What to do |
| --- | --- |
| `mqtt/ws` fails to import `ws` | Install `ws` in the same project, then rerun the import. Use `mqtt` for TCP and `mqtt/browser` for a browser. |
| A WebSocket URL is invalid or the upgrade fails | Check the broker's WebSocket listener, path, and port. Use `ws://` on a local HTTP page or `wss://` on an HTTPS page. MQTT TCP uses a separate listener. |
| CONNECT is refused | Read `reasonCode` on the `ERR_MQTT_REFUSED` error for the broker's MQTT reason. Check client access and authentication, then create a new factory. |
| The attempt times out or you cancel it | Check the broker and endpoint. To cancel, pass an `AbortSignal` in the factory options. Create a new signal and a new factory for another attempt. |
| A browser option is unsupported | Use the options in the browser guide. Browser TLS and proxy settings belong to the browser. The browser factory does not send a password in the current preview. |
| A local capacity error rejects a publish | That call was not sent. Wait for admitted work to settle before trying it again on an active session. |
| An admitted publish is interrupted | The broker may already have received it. Check the operation result and your application's record before sending it again. |

The session is one-shot. Repeated calls to the same factory's `connect()` return the original promise, including after rejection. A connection retry also needs a fresh underlying stream for a custom transport. [Browser options](../browser-client.md) · [Custom transport recipe](using-custom-transports.md) · [Publication admission](../outgoing-admission.md)

The packed recovery check confirms that capacity rejection happens before a write and that cancellation can interrupt a write after admission. The examples report a fixed connection failure message to avoid printing URL credentials. [Packed recovery check](../../test/packed/first-connection-recovery.mjs) · [Public types](../public-types.md) · [Error codes](../errors.md)

This sample trace illustrates a successful exchange when you are reading without a broker. It is not a live connection.

```text
CONNECT accepted
SUBSCRIBE example/echo accepted
PUBLISH example/echo
Received an echo on example/echo
DISCONNECT
```
