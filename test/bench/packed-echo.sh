#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 ]]; then
  echo 'Usage: MQTT_TEST_PORT=<port> bash test/bench/packed-echo.sh <baseline-consumer> <candidate-consumer>' >&2
  exit 2
fi

export MQTT_TEST_PORT=${MQTT_TEST_PORT:?Start the pinned Mosquitto broker and set MQTT_TEST_PORT}
export MQTT_TEST_ITERATIONS=${MQTT_TEST_ITERATIONS:-10000}
unset MQTT_TEST_HOST MQTT_TEST_WS_URL MQTT_TEST_TLS MQTT_TEST_CA MQTT_TEST_CERT MQTT_TEST_KEY MQTT_TEST_PROXY

baseline=$(realpath "$1")
candidate=$(realpath "$2")
runner=$(realpath "$(dirname "$0")/../packed/broker.mjs")
fixture_baseline="$baseline/.mqtt-benchmark-echo.mjs"
fixture_candidate="$candidate/.mqtt-benchmark-echo.mjs"
if [[ "$baseline" == "$candidate" || -e "$fixture_baseline" || -e "$fixture_candidate" ]]; then
  echo 'Use two distinct consumer directories without an existing .mqtt-benchmark-echo.mjs' >&2
  exit 2
fi
trap 'rm -f -- "$fixture_baseline" "$fixture_candidate"' EXIT
cp -- "$runner" "$fixture_baseline"
cp -- "$runner" "$fixture_candidate"

node -p 'JSON.stringify({node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch})'
run_echo() {
  local label=$1 fixture=$2
  echo "$label"
  timeout 60 node "$fixture"
}

for pair in 1 2 3 4 5; do
  if (( pair % 2 == 1 )); then
    run_echo "pair $pair baseline" "$fixture_baseline"
    run_echo "pair $pair candidate" "$fixture_candidate"
  else
    run_echo "pair $pair candidate" "$fixture_candidate"
    run_echo "pair $pair baseline" "$fixture_baseline"
  fi
done
