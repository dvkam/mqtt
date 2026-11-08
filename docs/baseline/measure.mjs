import { createServer } from 'node:net';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { connectAsync } from 'mqtt';
import { generate, parser } from 'mqtt-packet';
import { build } from 'vite';
import { gzipSync } from 'node:zlib';
import { createServer as createHttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright-core';

const server = createServer((socket) => {
  const decoder = parser({ protocolVersion: 5 });
  socket.on('data', (chunk) => decoder.parse(chunk));
  decoder.on('packet', (packet) => {
    const replies = {
      connect: { cmd: 'connack', reasonCode: 0, sessionPresent: false },
      publish: { cmd: 'puback', reasonCode: 0, messageId: packet.messageId },
    };
    const reply = replies[packet.cmd];
    if (reply) socket.write(generate(reply, { protocolVersion: 5 }));
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const client = await connectAsync(`mqtt://127.0.0.1:${server.address().port}`, {
    protocolVersion: 5,
    reconnectPeriod: 0,
    connectTimeout: 2000,
  });
  let deadline;
  try {
    const timedOut = new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('TCP workload exceeded 10 seconds')), 10_000);
    });
    await Promise.race([timedOut, measurePublishes(client)]);
  } finally {
    clearTimeout(deadline);
    await client.endAsync(true);
  }
} finally {
  server.close();
}

async function measurePublishes(client) {
  const payload = Buffer.alloc(256);
  const publish = () => client.publishAsync('baseline/qos1', payload, { qos: 1 });
  for (let warmupIndex = 0; warmupIndex < 200; warmupIndex++) await publish();
  for (let round = 0; round < 3; round++) {
    const start = performance.now();
    const latencies = [];
    for (let publicationIndex = 0; publicationIndex < 2000; publicationIndex++) {
      const sent = performance.now();
      await publish();
      latencies.push(performance.now() - sent);
    }
    const throughput = (2000 * 1000) / (performance.now() - start);
    latencies.sort((leftMilliseconds, rightMilliseconds) => leftMilliseconds - rightMilliseconds);
    console.log(JSON.stringify({ round, throughput, p99Ms: latencies[1979] }));
  }
}
const result = await build({
  logLevel: 'silent',
  build: {
    write: false,
    lib: {
      entry: 'browser.mjs',
      formats: ['es'],
      fileName: 'mqtt-consumer',
    },
    minify: true,
  },
});
const code = result[0].output.find((item) => item.type === 'chunk').code;
console.log(JSON.stringify({ minifiedBytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).length }));

const http = createHttpServer((request, response) => {
  if (request.url === '/consumer.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(code);
    return;
  }
  response.end('<!doctype html><title>MQTT browser baseline</title>');
});
const broker = new WebSocketServer({ server: http });
broker.on('connection', (socket) => {
  const decoder = parser({ protocolVersion: 5 });
  socket.on('message', (bytes) => decoder.parse(bytes));
  decoder.on('packet', (packet) => {
    if (packet.cmd === 'connect')
      socket.send(
        generate(
          {
            cmd: 'connack',
            reasonCode: 0,
            sessionPresent: false,
          },
          { protocolVersion: 5 },
        ),
      );
  });
});
http.listen(0, '127.0.0.1');
await once(http, 'listening');
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage();
  const port = http.address().port;
  await page.goto(`http://127.0.0.1:${port}/`);
  const result = await page.evaluate(async (url) => {
    const { openBrowserClient } = await import('/consumer.js');
    const client = openBrowserClient(url);
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No browser CONNACK')), 3000);
        client.once('connect', (ack) => {
          clearTimeout(timer);
          resolve(ack.reasonCode);
        });
        client.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    } finally {
      client.end(true);
    }
  }, `ws://127.0.0.1:${port}`);
  if (result !== 0) throw new Error(`Unexpected browser CONNACK: ${result}`);
  console.log(JSON.stringify({ browser: browser.version(), connack: result }));
} finally {
  await browser?.close();
  for (const socket of broker.clients) socket.terminate();
  broker.close();
  http.close();
}
