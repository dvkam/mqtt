# Legacy connection inputs

The root `connect` function accepts a `ConnectInput` with a string or URL in `brokerUrl`. It snapshots the top-level options and constructs its own URL before building the legacy client. Frozen caller options work on success and remain intact when validation rejects them. Changing the client's URL later leaves the original URL unchanged.

`ConnectOptions` still describes the resolved options received by the legacy constructor and custom stream factory. Its endpoint is a URL. Stream factories, native credential buffers and other nested objects keep their existing mutable types and identities.

```ts
import { connect, type ConnectInput } from 'mqtt';

const options: ConnectInput = {
  brokerUrl: 'mqtt://localhost:1883',
  clientId: 'legacy-example',
};

const client = await connect(Object.freeze(options));
await client.disconnect();
```

A certificate and key together require `mqtts:`, `tls:` or `wss:`. Validation rejects an insecure scheme before constructing the transport. The policy uses the platform URL's protocol strings, including their trailing colon. URL parsing failures report `Invalid broker URL` without the native error's credential-bearing input field. MQTT username and password options keep their existing meanings.

## Native socket hosts

Legacy TCP and TLS connections remove URL brackets before passing an IPv6 address to the native socket. The explicit endpoint port stays separate. TLS supplies the DNS hostname without its port as SNI and omits SNI for IPv4 and IPv6 literals. Caller-provided TLS options retain their existing override behavior. [Node TLS options](https://nodejs.org/api/tls.html#tlsconnectoptions-callback)

A real IPv6 loopback test verifies CONNECT and DISCONNECT at an explicit port. Three TLS configuration tests cover a DNS name, IPv4 and IPv6. These four cases failed before the host and SNI correction. The full focused legacy run passed twenty-four tests.

## Verification and remaining work

Ten regression cases failed against the old source. The restored legacy client and TLS cleanup run passed twenty tests. The installed declaration fixture accepts a typed string endpoint. Existing mutation fixtures still require writable custom factory options and mutable credential buffers.

The tests use a scripted custom stream to isolate normalization and certificate-scheme policy. Remaining endpoint policies and native WebSocket factory behavior stay under #30. The supported preview transport interfaces are described in their transport guides.
