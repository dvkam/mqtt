#!/usr/bin/env bash
set -euo pipefail
consumer=$1
shift
made_dir=
if [[ -z ${MQTT_BROKER_DIR:-} ]]; then
  made_dir=$(mktemp -d)
fi
broker_dir=${MQTT_BROKER_DIR:-$made_dir}
if ( : > /dev/tcp/127.0.0.1/18891 ) 2>/dev/null; then
  echo 'Port 18891 is in use, so the check cannot start its own broker' >&2
  exit 1
fi
printf 'listener 18891 127.0.0.1\nallow_anonymous true\nprotocol websockets\npersistence false\n' > "$broker_dir/lifecycle.conf"
"${MOSQUITTO_BIN:-mosquitto}" -c "$broker_dir/lifecycle.conf" &
broker=$!
trap 'kill "$broker" 2>/dev/null || true; if [[ -n $made_dir ]]; then rm -rf "$made_dir"; fi' EXIT
timeout 10 bash -c 'until ( : > /dev/tcp/127.0.0.1/18891 ) 2>/dev/null; do sleep 0.1; done'
if ! kill -0 "$broker" 2>/dev/null; then
  echo 'The broker that this check started is not running' >&2
  exit 1
fi
timeout 240 node test/packed/page-lifecycle.ts "$consumer" ws://127.0.0.1:18891/mqtt "$@"
if [[ " $* " == *' chromium '* ]]; then
  # The step budgets of the hidden tab check add up to 540 seconds, so its watchdog names a step that hangs before
  # this timeout ends the check.
  timeout 600 node test/packed/page-lifecycle-hidden.ts "$consumer" ws://127.0.0.1:18891/mqtt
fi
