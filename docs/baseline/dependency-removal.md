# Historical dependency removal observations

This record recovers measurements from PR #59. The before source is 5145c5330486be88b0dabb28551acafd5cd65e27. The after head is d9afe8adb81c23e890fa48866decf21b5a750a57, merged as 5002e9987844281d29bd78b7e6172375fd01e044. These are historical observations, not a new benchmark run.

| Installed tree observation | Before | After |
| --- | ---: | ---: |
| Unique package name/version pairs, including mqtt | 43 | 34 |
| Recorded installed size in KiB | 8124 | 6512 |
| Portable browser bundle bytes | 4921 | 4921 |
| Portable browser gzip bytes | 1661 | 1663 |

The after install log says it removed nine packages and changed one package. The before log records adding 43 packages. The paired tree comparison therefore was not two fresh installations, despite the earlier issue description. The separate packed-consumer check did install the after tarball into a fresh consumer and recorded adding 34 packages. These numbers do not establish universal disk savings or allocation behavior.

The local comparison script recursively deduplicates package name/version pairs. It does not count physical directories. The nine removed pairs were duplexify 4.1.3, end-of-stream 1.4.5, js-sdsl 4.3.0, once 1.4.0, number-allocator 1.0.14, readable-stream 3.6.2, stream-shift 1.0.3, util-deprecate 1.0.2 and wrappy 1.0.2. Other transitive copies can remain through retained dependencies.

Local evidence survives in outputs/unused-dependency-comparison.json, work/compare-dependency-installs.py, work/dependency-before and work/dependency-after. The directories retain tree.json, size.txt, package-lock.json, install.log, pack.log and tarballs. Obsolete dependency installations were removed during disk cleanup. Before tarball SHA256 is cafc362e9dc746a38e8b6e1bd4e9d17754059f110436de56f9befaf08df810ca. After SHA256 is cda392bbde08b445fc176ab156edeb0519fce1e3aa22aa45709a830df12a4f4e.

Node v26.13.0 and Chromium 158.0.8127.18 appear in the retained validation logs. The exact historical install and size shell invocations were not preserved. To reproduce the comparison, pack each pinned checkout, install each tarball into its own empty ESM consumer with npm, record the complete dependency tree and directory size, then run the comparison script. This is a reconstructed procedure; it differs from the preserved incremental after installation.

## After-removal integration observations

| Workload | Exchanges | Echoes/second | p99 milliseconds |
| --- | ---: | ---: | ---: |
| Packed TCP | 100 | 4462.989255755037 | 2.4880919999999946 |
| WS | 5 | 2007.3871848402061 | 0.8129999999999882 |
| WSS | 5 | 1001.9236934915106 | 3.562599999999975 |
| Mutual TLS | 5 | 1160.3889623801915 | 3.006999999999948 |
| CONNECT proxy | 1 | 1202.2120702092036 | 0.8213000000000079 |

Mosquitto was 2.0.18. These small validation samples establish working exchanges, not a speed comparison. The WebSocket graph recorded 21061 raw bytes and 6010 gzip bytes. Native direct WSS failure and successful gateway WSS remain distinct outcomes.

| Pressure probe | Admitted messages | Peak bytes | Budget bytes | Next would exceed budget | Close milliseconds |
| --- | ---: | ---: | ---: | --- | ---: |
| ws | 39 | 65550 | 131072 | true | 498.1210180000003 |
| Native Node | 2 | 131072 | 131072 | true | 498.8497860000002 |
| Chromium | 2 | 131072 | 131072 | true | 499.0999999999767 |

Sources are work/no-any-packed.log, work/unused-deps-packed.log, work/unused-deps-ws.log and work/unused-deps-wss.log. The WSS row labels follow the pinned script's execution order. Current test scripts have changed since that run and must not be presented as the exact historical commands. Gzip variation has no attributed cause.
