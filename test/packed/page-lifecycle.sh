#!/usr/bin/env bash
set -euo pipefail
consumer=$1
shift
broker_dir=${MQTT_BROKER_DIR:-$(mktemp -d)}
printf 'listener 18884 127.0.0.1\nallow_anonymous true\nprotocol websockets\npersistence false\n' > "$broker_dir/lifecycle.conf"
"${MOSQUITTO_BIN:-mosquitto}" -c "$broker_dir/lifecycle.conf" &
broker=$!
trap 'kill "$broker" 2>/dev/null || true' EXIT
timeout 10 bash -c 'until ( : > /dev/tcp/127.0.0.1/18884 ) 2>/dev/null; do sleep 0.1; done'
timeout 240 node test/packed/page-lifecycle.ts "$consumer" ws://127.0.0.1:18884/mqtt "$@"
