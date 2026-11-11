#!/usr/bin/env bash
set -euo pipefail
image=eclipse-mosquitto@sha256:81a6193ae693942a3231cd3ac52875b02b7e3a19da671b2fb4b55cc874c5b279
if [[ $# == 1 && $1 == --pull ]]; then
  exec docker pull "$image"
fi
broker_dir=$(realpath -e "${MQTT_BROKER_DIR:?Set MQTT_BROKER_DIR to the broker configuration directory}")
exec docker run --rm --network host --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$broker_dir,target=$broker_dir,readonly" \
  "$image" mosquitto "$@"
