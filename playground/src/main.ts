import {
  createBrowserClient,
  isMqttError,
  type BrowserMessage,
  type BrowserQosOneMessage,
  type ClientDiagnostic,
  type ClientSession,
  type SessionEnd,
} from 'mqtt/browser';
import { createTransportClient } from 'mqtt/portable';
import { scriptedBroker } from './scripted.js';

function element<Type extends HTMLElement>(id: string, type: new () => Type): Type {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error('Missing #' + id);
  return found;
}

const mode = element('mode', HTMLSelectElement);
const url = element('url', HTMLInputElement);
const clientId = element('client-id', HTMLInputElement);
const username = element('username', HTMLInputElement);
const password = element('password', HTMLInputElement);
const willTopic = element('will-topic', HTMLInputElement);
const connectButton = element('connect', HTMLButtonElement);
const snapshot = element('snapshot', HTMLPreElement);
const filter = element('filter', HTMLInputElement);
const subscribeQos = element('subscribe-qos', HTMLSelectElement);
const subscribeButton = element('subscribe', HTMLButtonElement);
const topic = element('topic', HTMLInputElement);
const payload = element('payload', HTMLInputElement);
const publishQos = element('publish-qos', HTMLSelectElement);
const retain = element('retain', HTMLInputElement);
const publishButton = element('publish', HTMLButtonElement);
const drain = element('drain', HTMLInputElement);
const sendWill = element('send-will', HTMLInputElement);
const disconnectButton = element('disconnect', HTMLButtonElement);
const results = element('results', HTMLOListElement);
const messages = element('messages', HTMLOListElement);
const diagnostics = element('diagnostics', HTMLOListElement);

let session: ClientSession | undefined;
const decoder = new TextDecoder();

function log(list: HTMLOListElement, text: string, kind = 'info'): void {
  const item = document.createElement('li');
  item.textContent = text;
  item.dataset['kind'] = kind;
  list.prepend(item);
}

/** A rejection as the page shows it: the stable code and whether the session ended, or the message for other errors. */
function describe(error: unknown): string {
  if (isMqttError(error)) {
    const reason = error.reasonCode === undefined ? '' : ` reason 0x${error.reasonCode.toString(16)}`;
    return `${error.code}${reason} fatal=${String(error.fatal)}: ${error.message}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function setConnected(connected: boolean): void {
  connectButton.disabled = connected;
  subscribeButton.disabled = !connected;
  publishButton.disabled = !connected;
  disconnectButton.disabled = !connected;
}

function qos(select: HTMLSelectElement): 0 | 1 {
  return select.value === '1' ? 1 : 0;
}

// Diagnostics carry packet commands and connection states only, never topics, payloads or credentials.
function onDiagnostic(event: ClientDiagnostic): void {
  log(diagnostics, event.kind === 'packet' ? `${event.direction} ${event.command}` : `connection ${event.state}`);
}

function showMessage(message: BrowserMessage | BrowserQosOneMessage): void {
  log(messages, `${message.topic} [QoS ${String(message.qos)}] ${decoder.decode(message.payload)}`);
}

mode.addEventListener('change', () => {
  url.disabled = mode.value === 'scripted';
});
url.disabled = mode.value === 'scripted';

connectButton.addEventListener('click', () => {
  void (async () => {
    connectButton.disabled = true;
    // The credentials stay in the form fields and this call. The page stores nothing.
    const shared = {
      clientId: clientId.value,
      onDiagnostic,
      onMessage: showMessage,
      onQosOneMessage: showMessage,
      onSessionEnd(event: SessionEnd) {
        log(results, event.kind === 'error' ? `session ended: ${describe(event.error)}` : 'session ended: disconnect', event.kind);
        session = undefined;
        setConnected(false);
        snapshot.textContent = 'Not connected';
      },
      ...(username.value === '' ? {} : { username: username.value }),
      ...(password.value === '' ? {} : { password: password.value }),
      ...(willTopic.value === '' ? {} : { will: { topic: willTopic.value, payload: 'offline' } }),
    };
    try {
      const factory =
        mode.value === 'scripted'
          ? createTransportClient(scriptedBroker(), shared)
          : createBrowserClient({ ...shared, url: url.value });
      session = await factory.connect();
      snapshot.textContent = JSON.stringify(session.connection, undefined, 2);
      log(results, `connected as ${session.connection.clientId}`, 'ok');
      setConnected(true);
    } catch (error) {
      log(results, `connect failed: ${describe(error)}`, 'error');
      setConnected(false);
    }
  })();
});

subscribeButton.addEventListener('click', () => {
  void (async () => {
    try {
      const result = await session?.subscribe(filter.value, { qos: qos(subscribeQos) });
      log(results, `subscribed ${filter.value}: granted QoS ${String(result?.grantedQos)}`, 'ok');
    } catch (error) {
      log(results, `subscribe ${filter.value} failed: ${describe(error)}`, 'error');
    }
  })();
});

publishButton.addEventListener('click', () => {
  void (async () => {
    const level = qos(publishQos);
    try {
      await session?.publish(topic.value, payload.value, { qos: level, retain: retain.checked });
      log(results, `published ${topic.value} at QoS ${String(level)}${level === 1 ? ': PUBACK' : ''}`, 'ok');
    } catch (error) {
      log(results, `publish ${topic.value} failed: ${describe(error)}`, 'error');
    }
  })();
});

disconnectButton.addEventListener('click', () => {
  void (async () => {
    try {
      await session?.disconnect({ drain: drain.checked, reasonCode: sendWill.checked ? 4 : 0 });
      log(results, `disconnected${sendWill.checked ? ' with the Will' : ''}`, 'ok');
    } catch (error) {
      log(results, `disconnect failed: ${describe(error)}`, 'error');
    }
  })();
});

setConnected(false);
