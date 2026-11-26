// Builds the playground, serves the build and drives it in Chromium. Set MQTT_PLAYGROUND_WS_URL to also run the same
// steps against a broker over WebSocket. Run from the repository root after installing the packed tarball into playground.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
await build({ root, logLevel: 'warn' });

// The bundle must use only browser entry points, so it holds no Node built-in import.
const assets = fileURLToPath(new URL('../dist/assets/', import.meta.url));
for (const file of readdirSync(assets).filter((name) => name.endsWith('.js'))) {
  const code = readFileSync(assets + file, 'utf8');
  assert.doesNotMatch(code, /from ["']node:|require\(["']node:/u, file + ' imports a Node built-in');
}

const server = await preview({ root, preview: { port: 0, host: '127.0.0.1' }, logLevel: 'warn' });
const address = server.resolvedUrls?.local[0];
assert.ok(address !== undefined);
const browser = await chromium.launch();
try {
  const modes = [{ mode: 'scripted', url: '' }];
  const brokerUrl = process.env['MQTT_PLAYGROUND_WS_URL'];
  if (brokerUrl !== undefined && brokerUrl !== '') modes.push({ mode: 'broker', url: brokerUrl });
  for (const { mode, url } of modes) {
    const page = await browser.newPage();
    /** @type {string[]} */
    const pageErrors = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });
    await page.goto(address);
    await page.selectOption('#mode', mode);
    if (url !== '') await page.fill('#url', url);
    await page.fill('#client-id', `playground-smoke-${mode}-${process.pid}`);
    await page.click('#connect');
    await page.getByTestId('results').getByText('connected as').waitFor();
    assert.match((await page.getByTestId('snapshot').textContent()) ?? '', /"receiveMaximum"/u);

    await page.fill('#filter', `playground/${process.pid}/#`);
    await page.selectOption('#subscribe-qos', '1');
    await page.click('#subscribe');
    await page.getByTestId('results').getByText('granted QoS 1').waitFor();

    for (const qos of ['0', '1']) {
      await page.fill('#topic', `playground/${process.pid}/qos${qos}`);
      await page.fill('#payload', `hello at QoS ${qos}`);
      await page.selectOption('#publish-qos', qos);
      await page.click('#publish');
      await page.getByTestId('messages').getByText(`hello at QoS ${qos}`).waitFor();
    }
    await page.getByTestId('results').getByText(': PUBACK').waitFor();
    await page.getByTestId('reconnects').getByText('connected generation 1 attempt 1, previous end: none').waitFor();

    if (mode === 'scripted') {
      // The scripted broker never acknowledges this topic, so the drop leaves the publication uncertain.
      await page.fill('#topic', 'playground/unacknowledged');
      await page.selectOption('#publish-qos', '1');
      await page.click('#publish');
      await page.click('#drop');
      await page.getByTestId('results').getByText('dropped the scripted connection').waitFor();
      await page.getByTestId('results').getByText('publish playground/unacknowledged failed: ERR_MQTT_TRANSPORT').waitFor();
      await page
        .getByTestId('reconnects')
        .getByText(/^retrying attempt 2 in \d+ ms after ERR_MQTT_TRANSPORT/u)
        .waitFor();
      await page
        .getByTestId('reconnects')
        .getByText(
          /^connected generation 2 attempt 2, previous end: ERR_MQTT_TRANSPORT .*uncertain publications: playground\/unacknowledged #\d+$/u,
        )
        .waitFor();
      await page.getByTestId('results').getByText(`subscribed playground/${process.pid}/# again after the reconnect`).waitFor();
      await page.fill('#topic', `playground/${process.pid}/again`);
      await page.fill('#payload', 'hello after the reconnect');
      await page.selectOption('#publish-qos', '0');
      await page.click('#publish');
      await page.getByTestId('messages').getByText('hello after the reconnect').waitFor();
    } else {
      assert.equal(await page.isDisabled('#drop'), true, 'only the scripted broker can drop its connection');
    }

    // An invalid topic shows its stable code and leaves the session usable.
    await page.fill('#topic', 'playground/+');
    await page.click('#publish');
    await page.getByTestId('results').getByText('ERR_MQTT_INVALID_ARGUMENT').waitFor();

    await page.click('#disconnect');
    await page
      .getByTestId('results')
      .getByText(/^disconnected/u)
      .waitFor();
    await page.getByTestId('reconnects').getByText('stopped: disconnect').waitFor();
    const diagnostics = (await page.getByTestId('diagnostics').textContent()) ?? '';
    assert.match(diagnostics, /outbound connect/u);
    assert.doesNotMatch(diagnostics, /hello/u, 'diagnostics hold no payload');
    assert.deepEqual(pageErrors, []);
    console.log(
      `Playground ${mode} mode connected, subscribed, published at QoS 0 and 1${mode === 'scripted' ? ', reconnected after a drop' : ''} and disconnected in Chromium`,
    );
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
