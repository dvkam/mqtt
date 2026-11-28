// Builds the playground, serves the build and drives it in Chromium. Set MQTT_PLAYGROUND_WS_URL to also run the same
// steps against a broker over WebSocket. Run from the repository root after installing the packed tarball into playground.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, createLogger, preview } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

// Vite replaces a Node built-in with an empty module and only warns, so the bundle holds no `node:` import to look for.
// The warning is the evidence that an import reached a Node-only entry point.
/** @type {string[]} */
const warnings = [];
const logger = createLogger('warn');
await build({
  root,
  logLevel: 'warn',
  customLogger: {
    ...logger,
    warn(message) {
      warnings.push(message);
      logger.warn(message);
    },
    warnOnce(message) {
      warnings.push(message);
      logger.warnOnce(message);
    },
  },
});
assert.deepEqual(
  warnings.filter((message) => message.includes('externalized for browser compatibility')),
  [],
  'the playground imports a Node built-in',
);
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
  const brokerUrl = process.env.MQTT_PLAYGROUND_WS_URL;
  if (brokerUrl !== undefined && brokerUrl !== '') modes.push({ mode: 'broker', url: brokerUrl });
  const username = `smoke-user-${process.pid}`;
  const password = `smoke-password-${process.pid}`;
  /** @type {('light' | 'dark')[]} */
  const schemes = ['light', 'dark'];
  for (const { mode, url } of modes) {
    const scripted = mode === 'scripted';
    const context = await browser.newContext();
    const page = await context.newPage();
    const results = page.getByTestId('results');
    const reconnects = page.getByTestId('reconnects');
    const messages = page.getByTestId('messages');
    const state = page.getByRole('status');
    const focused = async () => page.evaluate(() => document.activeElement?.id);
    await page.goto(address);

    for (const name of ['Reconnect', 'Results and errors', 'Messages', 'Diagnostics']) {
      await page.getByRole('log', { name }).focus();
      const heading = await page.evaluate(
        () => document.getElementById(document.activeElement?.getAttribute('aria-labelledby') ?? '')?.textContent,
      );
      assert.equal(heading, name, `the ${name} log takes the focus`);
    }
    assert.equal(await state.textContent(), 'Not connected.');

    await page.selectOption('#mode', mode);
    if (url !== '') await page.fill('#url', url);
    await page.fill('#client-id', `playground-smoke-${mode}-${process.pid}`);
    if (scripted) {
      await page.fill('#username', username);
      await page.fill('#password', password);
      await page.fill('#will-topic', `playground/${process.pid}/status`);
    }
    await page.focus('#connect');
    await page.keyboard.press('Enter');
    await results.getByText('connected as').waitFor();
    assert.equal(await focused(), 'disconnect', 'the focus moves to Disconnect when Connect is disabled');
    assert.match((await page.getByTestId('snapshot').textContent()) ?? '', /"receiveMaximum"/u);
    assert.equal(await state.textContent(), `Connected as playground-smoke-${mode}-${process.pid}, session 1.`);

    await page.fill('#filter', `playground/${process.pid}/#`);
    await page.selectOption('#subscribe-qos', '1');
    await page.click('#subscribe');
    await results.getByText('granted QoS 1').waitFor();

    for (const qos of ['0', '1']) {
      await page.fill('#topic', `playground/${process.pid}/qos${qos}`);
      await page.fill('#payload', `hello at QoS ${qos}`);
      await page.selectOption('#publish-qos', qos);
      await page.click('#publish');
      await messages.getByText(`playground/${process.pid}/qos${qos} [QoS ${qos}] hello at QoS ${qos}`).waitFor();
    }
    await results.getByText(': PUBACK').waitFor();

    // A retained message reaches a subscription made after it. An empty retained payload removes it. The marker arrives
    // after everything the broker sent for the last subscription, so one retained copy then means the message is gone.
    await page.fill('#topic', `playground/${process.pid}/retained`);
    await page.fill('#payload', 'kept');
    await page.check('#retain');
    await page.click('#publish');
    await messages.getByText(`playground/${process.pid}/retained [QoS 1] kept`).waitFor();
    await page.fill('#filter', `playground/${process.pid}/retained`);
    await page.selectOption('#subscribe-qos', '0');
    await page.click('#subscribe');
    await messages.getByText(`playground/${process.pid}/retained [QoS 0, retained] kept`).waitFor();
    await page.fill('#payload', '');
    await page.click('#publish');
    await results.getByText(`published playground/${process.pid}/retained at QoS 1: PUBACK`).nth(1).waitFor();
    await page.uncheck('#retain');
    await page.click('#subscribe');
    await results.getByText(`subscribed playground/${process.pid}/retained: granted QoS 0`).nth(1).waitFor();
    await page.fill('#topic', `playground/${process.pid}/marker`);
    await page.fill('#payload', 'after the retained message was removed');
    await page.click('#publish');
    await messages.getByText('after the retained message was removed').waitFor();
    assert.equal(await messages.getByText(', retained] kept').count(), 1, 'an empty retained payload removes the message');

    await reconnects.getByText('connected generation 1 attempt 1, previous end: none').waitFor();
    await page.click('#retry-now');
    await reconnects.getByText('retryNow() returned false').waitFor();

    // A headless page stays visible, so the page's visibilityState getter is replaced before the dispatched events.
    await page.evaluate(() => {
      let visibility = 'hidden';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
      document.dispatchEvent(new Event('visibilitychange'));
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await reconnects.getByText(/^page returned on visibilitychange after \d+ ms: answered$/u).waitFor();

    if (scripted) {
      await page.fill('#topic', 'playground/unacknowledged');
      await page.selectOption('#publish-qos', '1');
      await page.click('#publish');
      await page.click('#drop');
      await results.getByText('dropped the scripted connection').waitFor();
      await results.getByText('publish playground/unacknowledged failed: ERR_MQTT_TRANSPORT').waitFor();
      await reconnects
        .getByText(
          /^retrying attempt 2 in \d+ ms after ERR_MQTT_TRANSPORT.* The scripted broker ended the connection\. .*"Retry now"/u,
        )
        .waitFor();
      assert.match(
        (await state.textContent()) ?? '',
        /^Waiting to reconnect after ".*", attempt 2 in \d+ ms\. The scripted broker/u,
      );
      const retried = performance.now();
      assert.equal(await page.textContent('#recover'), 'Retry now');
      await page.click('#recover');
      await reconnects.getByText('retryNow() returned true').waitFor();
      await reconnects
        .getByText(
          /^connected generation 2 attempt 2, previous end: ERR_MQTT_TRANSPORT .*uncertain publications: playground\/unacknowledged #\d+$/u,
        )
        .waitFor();
      assert.ok(performance.now() - retried < 2000, 'retryNow() connects before the backoff of at least 2,500 ms ends');
      assert.equal(await page.isHidden('#recover'), true, 'the recovery button goes away once the session connected');
      await results.getByText(`subscribed playground/${process.pid}/# again after the reconnect`).waitFor();
      await messages.getByText(`playground/${process.pid}/status [QoS 0, retained] offline`).waitFor();
      await page.fill('#topic', `playground/${process.pid}/again`);
      await page.fill('#payload', 'hello after the reconnect');
      await page.selectOption('#publish-qos', '0');
      await page.click('#publish');
      await messages.getByText('hello after the reconnect').waitFor();
    } else {
      assert.equal(await page.isDisabled('#drop'), true, 'only the scripted broker can drop its connection');
    }

    await page.fill('#topic', 'playground/+');
    await page.click('#publish');
    await results.getByText('publish playground/+ failed: ERR_MQTT_INVALID_ARGUMENT fatal=false').waitFor();
    await page.fill('#topic', `playground/${process.pid}/usable`);
    await page.fill('#payload', 'hello after the invalid topic');
    await page.click('#publish');
    await messages.getByText('hello after the invalid topic').waitFor();

    for (const colorScheme of schemes) {
      await page.emulateMedia({ colorScheme });
      const ratios = await page.evaluate(() => {
        const luminance = (/** @type {string} */ color) => {
          const [red = 0, green = 0, blue = 0] = (color.match(/[\d.]+/gu) ?? []).map((value) => {
            const channel = Number(value) / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        };
        const background = luminance(getComputedStyle(document.body).backgroundColor);
        const found = [];
        for (const item of document.querySelectorAll('li[data-kind="ok"], li[data-kind="error"]')) {
          const text = luminance(getComputedStyle(item).color);
          found.push((Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05));
        }
        return found;
      });
      assert.ok(
        ratios.length > 1 && Math.min(...ratios) >= 4.5,
        `${colorScheme} contrast ${String(Math.min(...ratios))} is below 4.5`,
      );
    }

    await page.focus('#disconnect');
    await page.keyboard.press('Enter');
    await results.getByText(/^disconnected/u).waitFor();
    await reconnects.getByText('stopped: disconnect').waitFor();
    assert.equal(await state.textContent(), 'Not connected.');
    assert.equal(await focused(), 'connect', 'the focus moves to Connect when Disconnect is disabled');

    const diagnostics = (await page.getByTestId('diagnostics').textContent()) ?? '';
    assert.match(diagnostics, /outbound connect/u);
    assert.doesNotMatch(diagnostics, /hello|kept|offline|playground\//u, 'diagnostics hold no payload and no topic');
    const shown = await page.evaluate(() => document.body.innerText);
    const stored = await page.evaluate(async () =>
      JSON.stringify([Object.entries(sessionStorage), Object.entries(localStorage), document.cookie, await indexedDB.databases()]),
    );
    assert.match(stored, /playground\.client-id/u, 'the page stores the client identifier for a reload');
    for (const secret of [username, password]) {
      assert.ok(!shown.includes(secret), 'the page shows no credential');
      assert.ok(!stored.includes(secret), 'the page stores no credential');
    }
    assert.ok(!stored.includes('hello'), 'the page stores no payload');
    await page.reload();
    assert.equal(await page.inputValue('#mode'), mode, 'a reload keeps the mode');
    assert.equal(
      await page.inputValue('#client-id'),
      `playground-smoke-${mode}-${process.pid}`,
      'a reload keeps the client identifier',
    );
    assert.equal(await page.inputValue('#username'), '', 'a reload drops the user name');
    assert.equal(await page.inputValue('#password'), '', 'a reload drops the password');
    assert.deepEqual((await page.pageErrors()).map(String), []);
    console.log(
      `Playground ${mode} mode connected, subscribed, published at QoS 0 and 1, received and removed a retained message${scripted ? ', reconnected at once with the recovery button after a drop, received the retained Will' : ''}, reported a page return, kept the session after an invalid topic and disconnected in Chromium`,
    );
    await context.close();
  }

  // The preview server answers a WebSocket handshake with a plain HTTP response, so the connection fails at once.
  const page = await browser.newPage();
  const state = page.getByRole('status');
  const recover = page.locator('#recover');
  await page.goto(address);
  await page.selectOption('#mode', 'broker');
  await page.fill('#url', address);
  await page.click('#connect');
  assert.match((await state.textContent()) ?? '', /^The URL starts with http:\/\/\. .* use ws:\/\/ or wss:\/\/\.$/u);
  assert.equal(await page.getAttribute('#url', 'aria-invalid'), 'true');
  const suggestion = address.replace('http://', 'ws://');
  assert.equal(await recover.textContent(), `Use ${suggestion}`);
  await recover.click();
  assert.equal(await page.inputValue('#url'), suggestion);
  await page
    .getByTestId('reconnects')
    .getByText(
      /^retrying attempt 2 in \d+ ms after ERR_MQTT_TRANSPORT.* Start a local one with "mosquitto -c playground\/mosquitto\.conf"\./u,
    )
    .waitFor();
  assert.match(
    (await state.textContent()) ?? '',
    /^Waiting to reconnect after ".*", attempt 2 in \d+ ms\. Check that a broker listens/u,
  );
  assert.equal(await recover.textContent(), 'Retry now');
  await recover.click();
  await page.getByTestId('reconnects').getByText('retryNow() returned true').waitFor();
  await page.click('#disconnect');
  await page.getByTestId('reconnects').getByText('stopped: disconnect').waitFor();
  assert.equal(await recover.isHidden(), true);
  assert.deepEqual((await page.pageErrors()).map(String), []);
  console.log('Playground offered ws:// for an http:// URL and "Retry now" with the broker command after a failed handshake');
  await page.close();
} finally {
  await browser.close();
  await server.close();
}
