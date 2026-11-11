# MQTT over TCP with TLS

Pass a `tls` object to `createTcpClient` to authenticate the broker with Node's TLS client. An empty object uses the platform's trusted certificate authorities. TLS connections default to port 8883. Plain TCP defaults to 1883.

```ts
import { createTcpClient } from 'mqtt';

const client = await createTcpClient({
  host: 'broker.example',
  clientId: 'secure-preview',
  tls: {},
}).connect();

await client.publish('sensors/temperature', '21.5', { qos: 1 });
await client.disconnect();
```

`TcpTlsOptions` exposes `ca`, `cert`, `key` and `servername` with their native Node types. The adapter forwards these fields explicitly and requires certificate verification. Supply `ca` for a private broker authority. Supply `cert` and `key` for mutual TLS. The default SNI value is the DNS host. IP addresses omit automatic SNI, and an explicit `servername` uses Node's certificate-name verification rules. [Node TLS options](https://nodejs.org/api/tls.html#tlsconnectoptions-callback)

The client waits for `secureConnect` before creating the MQTT CONNECT exchange. Its connection timeout covers the TLS handshake. Cancellation closes a pending attempt and preserves the caller's Error. A native failure selected before cancellation keeps its outcome through teardown. Factory calls still share one connection promise.

The established session uses the same parser, packet limits, publication and subscription budgets, QoS 1 ownership and native write reserve as plain TCP. The native write counter describes queued plaintext bytes. TLS records, kernel buffers and total process memory are outside that admission bound.

## Verification

A real TCP peer holds the TLS handshake open. The test observes the actual TLS socket after TCP connection and checks that no MQTT CONNECT is submitted. A controlled timer checks timeout cleanup, and another test injects a native failure followed by cancellation. Source faults for early MQTT, replaced failure and retained abort listeners fail their regressions.

The installed tarball completes MQTT 5 exchanges over TLS and mutual TLS against Mosquitto. It rejects an unknown CA, a wrong hostname and a missing client certificate. The fixture supplies extra verification-disable settings to confirm that the adapter discards them. The same broker script retains WS/WSS and proxy checks. The [local observations](baseline/tcp-tls-checks.md) record the fixture timings and their scope.

The opening model checks authentication before MQTT, first failure and release of opening resources. It abstracts cryptography, byte contents, event-loop timing, native TLS buffers and MQTT acknowledgment processing.

TCP and TLS sockets disable Nagle buffering before opening completes. The [socket-delay experiment](baseline/native-socket-delay.md) records the local evidence and its limits.
