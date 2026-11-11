#!/usr/bin/env bash
set -euo pipefail
consumer=$1
broker_dir=${MQTT_BROKER_DIR:-$(mktemp -d)}
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=MQTT test CA' \
  -keyout "$broker_dir/ca.key" -out "$broker_dir/ca.pem" 2>/dev/null
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -keyout "$broker_dir/server.key" -out "$broker_dir/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n' > "$broker_dir/server.ext"
openssl x509 -req -in "$broker_dir/server.csr" -CA "$broker_dir/ca.pem" -CAkey "$broker_dir/ca.key" \
  -CAcreateserial -days 1 -extfile "$broker_dir/server.ext" -out "$broker_dir/server.pem" 2>/dev/null
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=MQTT test client' \
  -keyout "$broker_dir/client.key" -out "$broker_dir/client.csr" 2>/dev/null
printf 'extendedKeyUsage=clientAuth\n' > "$broker_dir/client.ext"
openssl x509 -req -in "$broker_dir/client.csr" -CA "$broker_dir/ca.pem" -CAkey "$broker_dir/ca.key" \
  -CAcreateserial -days 1 -extfile "$broker_dir/client.ext" -out "$broker_dir/client.pem" 2>/dev/null
cat > "$broker_dir/broker.conf" <<CONF
allow_anonymous true
listener 18888 127.0.0.1
protocol mqtt
certfile $broker_dir/server.pem
keyfile $broker_dir/server.key
listener 18889 127.0.0.1
protocol mqtt
certfile $broker_dir/server.pem
keyfile $broker_dir/server.key
cafile $broker_dir/ca.pem
require_certificate true
listener 18884 127.0.0.1
protocol websockets
listener 18885 127.0.0.1
protocol websockets
certfile $broker_dir/server.pem
keyfile $broker_dir/server.key
listener 18886 127.0.0.1
protocol websockets
certfile $broker_dir/server.pem
keyfile $broker_dir/server.key
cafile $broker_dir/ca.pem
require_certificate true
CONF
broker_conf="$broker_dir/broker.conf"
if [[ -n ${MQTT_BROKER_CONF:-} ]]; then
  sudo install -m 0644 "$broker_conf" "$MQTT_BROKER_CONF"
  broker_conf=$MQTT_BROKER_CONF
fi
"${MOSQUITTO_BIN:-mosquitto}" -c "$broker_conf" &
broker=$!
trap 'kill "$broker" ${gateway:+"$gateway"} 2>/dev/null || true' EXIT
timeout 10 bash -c 'until ( : > /dev/tcp/127.0.0.1/18885 ) 2>/dev/null; do sleep 0.1; done'
run_session() {
  MQTT_TEST_WS_URL="$1" MQTT_TEST_CA="${2:-}" MQTT_TEST_ITERATIONS=5 timeout 15 node "$consumer/broker.mjs"
}
run_tls_session() {
  MQTT_TEST_TLS=1 MQTT_TEST_HOST="${3:-localhost}" MQTT_TEST_PORT="$1" MQTT_TEST_CA="${2:-}" MQTT_TEST_ITERATIONS=5 timeout 15 node "$consumer/broker.mjs"
}
run_tls_session 18888 "$broker_dir/ca.pem"
if run_tls_session 18888 > "$broker_dir/tcp-unknown-ca.log" 2>&1; then
  echo 'Expected TCP TLS to reject the unknown CA' >&2
  exit 1
fi
grep -Eq 'UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN' "$broker_dir/tcp-unknown-ca.log"
if run_tls_session 18888 "$broker_dir/ca.pem" 127.0.0.1 > "$broker_dir/tcp-hostname.log" 2>&1; then
  echo 'Expected TCP TLS to reject the wrong hostname' >&2
  exit 1
fi
grep -q 'ERR_TLS_CERT_ALTNAME_INVALID' "$broker_dir/tcp-hostname.log"
MQTT_TEST_CERT="$broker_dir/client.pem" MQTT_TEST_KEY="$broker_dir/client.key"   run_tls_session 18889 "$broker_dir/ca.pem"
if run_tls_session 18889 "$broker_dir/ca.pem" > "$broker_dir/tcp-no-client-cert.log" 2>&1; then
  echo 'Expected TCP mTLS to reject the missing client certificate' >&2
  exit 1
fi
grep -Ei 'certificate.required|handshake.failure|socket hang up|alert' "$broker_dir/tcp-no-client-cert.log"
echo 'packed TCP TLS and mTLS checks passed'
run_session ws://127.0.0.1:18884/mqtt
run_session wss://localhost:18885/mqtt "$broker_dir/ca.pem"
if run_session wss://localhost:18885/mqtt > "$broker_dir/unknown-ca.log" 2>&1; then
  echo 'Expected WSS to reject the unknown CA' >&2
  exit 1
fi
grep -Eq 'UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN' "$broker_dir/unknown-ca.log"
if run_session wss://127.0.0.1:18885/mqtt "$broker_dir/ca.pem" > "$broker_dir/hostname.log" 2>&1; then
  echo 'Expected WSS to reject the wrong hostname' >&2
  exit 1
fi
grep -q 'ERR_TLS_CERT_ALTNAME_INVALID' "$broker_dir/hostname.log"
MQTT_TEST_CERT="$broker_dir/client.pem" MQTT_TEST_KEY="$broker_dir/client.key" \
  run_session wss://localhost:18886/mqtt "$broker_dir/ca.pem"
if run_session wss://localhost:18886/mqtt "$broker_dir/ca.pem" > "$broker_dir/no-client-cert.log" 2>&1; then
  echo 'Expected mTLS to reject the missing client certificate' >&2
  exit 1
fi
grep -Ei 'certificate.required|handshake.failure|socket hang up|alert' "$broker_dir/no-client-cert.log"
cp test/packed/websocket-session.mjs "$consumer/"
session=test/packed/websocket-session-check.ts
timeout 20 node "$session" "$consumer" ws://127.0.0.1:18884/mqtt
node test/packed/websocket-tls-gateway.ts "$broker_dir/server.pem" "$broker_dir/server.key" &
gateway=$!
timeout 10 bash -c 'until ( : > /dev/tcp/127.0.0.1/18887 ) 2>/dev/null; do sleep 0.1; done'
if ! NODE_EXTRA_CA_CERTS="$broker_dir/ca.pem" timeout 20 node "$session" "$consumer" wss://localhost:18885/mqtt > "$broker_dir/native-direct.log" 2>&1; then
  grep -q 'WebSocket over HTTP2 is experimental' "$broker_dir/native-direct.log"
  grep -q 'WebSocket ended during MQTT exchange' "$broker_dir/native-direct.log"
  echo 'Native Node direct WSS did not complete the exchange and emitted its HTTP/2 warning'
else
  cat "$broker_dir/native-direct.log"
fi
NODE_EXTRA_CA_CERTS="$broker_dir/ca.pem" timeout 20 node "$session" "$consumer" wss://localhost:18887/mqtt
if timeout 20 node "$session" "$consumer" wss://localhost:18887/mqtt > "$broker_dir/native-unknown-ca.log" 2>&1; then
  echo 'Expected native WSS to reject the unknown CA' >&2
  exit 1
fi
grep -q 'MQTT WebSocket handshake failed' "$broker_dir/native-unknown-ca.log"
if NODE_EXTRA_CA_CERTS="$broker_dir/ca.pem" timeout 20 node "$session" "$consumer" wss://127.0.0.1:18887/mqtt > "$broker_dir/native-hostname.log" 2>&1; then
  echo 'Expected native WSS to reject the wrong hostname' >&2
  exit 1
fi
grep -q 'MQTT WebSocket handshake failed' "$broker_dir/native-hostname.log"
if [[ ${MQTT_TEST_CHROMIUM:-0} == 1 ]]; then
  timeout 30 node "$session" "$consumer" ws://127.0.0.1:18884/mqtt chromium
  chromium_home=$(mktemp -d)
  mkdir -p "$chromium_home/.pki/nssdb"
  "${CERTUTIL_BIN:-certutil}" -N -d "sql:$chromium_home/.pki/nssdb" --empty-password
  if MQTT_CHROMIUM_HOME="$chromium_home" timeout 30 node "$session" "$consumer" wss://localhost:18887/mqtt chromium > "$broker_dir/chromium-ca.log" 2>&1; then
    echo 'Expected Chromium WSS to reject the unknown CA' >&2
    exit 1
  fi
  grep -q 'MQTT WebSocket handshake failed' "$broker_dir/chromium-ca.log"
  "${CERTUTIL_BIN:-certutil}" -A -d "sql:$chromium_home/.pki/nssdb" -n mqtt-test -t 'C,,' -i "$broker_dir/ca.pem"
  export MQTT_CHROMIUM_HOME="$chromium_home"
  timeout 30 node "$session" "$consumer" wss://localhost:18887/mqtt chromium
  if timeout 30 node "$session" "$consumer" wss://127.0.0.1:18887/mqtt chromium > "$broker_dir/chromium-hostname.log" 2>&1; then
    echo 'Expected Chromium WSS to reject the wrong hostname' >&2
    exit 1
  fi
  grep -q 'MQTT WebSocket handshake failed' "$broker_dir/chromium-hostname.log"
fi
timeout 50 node test/packed/websocket-proxy-check.ts "$consumer" "$broker_dir/ca.pem"
