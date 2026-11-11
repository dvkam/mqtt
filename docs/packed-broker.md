# Packed broker checks

Required CI runs the installed tarball against the official Eclipse Mosquitto 2.0.22 container. The launcher pins the multi-platform manifest to `sha256:81a6193ae693942a3231cd3ac52875b02b7e3a19da671b2fb4b55cc874c5b279`, checked from the official image metadata on 11 November 2026. [Official image](https://hub.docker.com/_/eclipse-mosquitto)

The workflow pulls the image with a 180-second deadline before starting the ten-second broker readiness check. TCP and WS/WSS use the same image and existing configurations. The container shares the Linux runner's network, runs with the runner's UID and GID, and mounts the broker configuration and generated certificates read-only at their existing absolute paths. The launcher replaces its shell with the Docker process so the existing broker PID trap can send termination to it. Docker forwards that signal to Mosquitto and removes the stopped container.

The required checks cover the public MQTT 5 clients, unknown CA, hostname mismatch, client certificates and the proxy paths. They use the existing consumer deadlines and preserve their exit status. Scheduled browser tools still use the runner's package setup.

## Local reproduction

The existing local checks can use native Mosquitto. For a Linux host with Docker, set the broker directory before invoking the container launcher.

```sh
bash test/packed/mosquitto-container.sh --pull
MQTT_BROKER_DIR="$broker_dir" bash test/packed/mosquitto-container.sh -c "$broker_dir/broker.conf"
```

The Linux launcher tests check the digest, network mode, user, read-only mount, argument forwarding and nonzero exit propagation with a scripted Docker command. They run before the hosted job exercises a real container. Windows skips these Linux shell checks. Existing library tests continue to run on Windows.
