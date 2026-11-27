import {
  createBrowserClient,
  createReconnectingClient,
  isMqttError,
  watchPageLifecycle,
  type BrowserMessage,
  type BrowserQosOneMessage,
  type ClientDiagnostic,
  type ClientSession,
  type PageReturn,
  type ReconnectEvent,
  type ReconnectOptions,
  type ReconnectingClient,
  type SessionEnd,
} from 'mqtt/browser';
import { createTransportClient } from 'mqtt/portable';
import { scriptedBroker, type ScriptedBroker } from './scripted.js';

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
const dropButton = element('drop', HTMLButtonElement);
const retryButton = element('retry-now', HTMLButtonElement);
const reconnects = element('reconnects', HTMLOListElement);
const results = element('results', HTMLOListElement);
const messages = element('messages', HTMLOListElement);
const diagnostics = element('diagnostics', HTMLOListElement);

let client: ReconnectingClient | undefined;
let session: ClientSession | undefined;
let broker: ScriptedBroker | undefined;
let stopWatching: (() => void) | undefined;
const subscribed = new Map<string, 0 | 1>();
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

function setState(state: 'idle' | 'waiting' | 'connected'): void {
  connectButton.disabled = state !== 'idle';
  subscribeButton.disabled = state !== 'connected';
  publishButton.disabled = state !== 'connected';
  disconnectButton.disabled = state === 'idle';
  dropButton.disabled = state !== 'connected' || broker === undefined;
  retryButton.disabled = state === 'idle';
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

function previousEnd(end: SessionEnd | undefined): string {
  if (end === undefined) return 'none';
  if (end.kind === 'disconnect') return 'disconnect';
  const uncertain = (end.uncertain ?? []).map(
    (publication) => `${publication.topic} #${String(publication.messageId)}${publication.acknowledged ? ' acknowledged' : ''}`,
  );
  return `${describe(end.error)}; uncertain publications: ${uncertain.length === 0 ? 'none' : uncertain.join(', ')}`;
}

async function subscribeAgain(current: ClientSession): Promise<void> {
  for (const [filter, level] of subscribed) {
    try {
      await current.subscribe(filter, { qos: level });
      log(results, `subscribed ${filter} again after the reconnect`, 'ok');
    } catch (error) {
      log(results, `subscribe ${filter} again failed: ${describe(error)}`, 'error');
    }
  }
}

function onReturn(event: PageReturn): void {
  log(reconnects, `page returned on ${event.trigger} after ${String(Math.round(event.awayMs))} ms: ${event.outcome}`, 'info');
}

function onReconnect(event: ReconnectEvent): void {
  if (event.kind === 'connected') {
    session = event.session;
    snapshot.textContent = JSON.stringify(event.session.connection, undefined, 2);
    log(
      reconnects,
      `connected generation ${String(event.generation)} attempt ${String(event.attempt)}, previous end: ${previousEnd(event.previous)}`,
      'ok',
    );
    if (event.generation === 1) log(results, `connected as ${event.session.connection.clientId}`, 'ok');
    setState('connected');
    if (event.generation > 1) void subscribeAgain(event.session);
  } else if (event.kind === 'retrying') {
    session = undefined;
    snapshot.textContent = 'Waiting to reconnect';
    log(
      reconnects,
      `retrying attempt ${String(event.attempt)} in ${String(Math.round(event.delayMs))} ms after ${describe(event.error)}`,
      'error',
    );
    setState('waiting');
  } else {
    stopWatching?.();
    stopWatching = undefined;
    client = undefined;
    session = undefined;
    broker = undefined;
    subscribed.clear();
    snapshot.textContent = 'Not connected';
    log(
      reconnects,
      `stopped: ${event.reason}${event.error === undefined ? '' : ` ${describe(event.error)}`}`,
      event.error === undefined ? 'info' : 'error',
    );
    setState('idle');
  }
}

mode.addEventListener('change', () => {
  url.disabled = mode.value === 'scripted';
});
url.disabled = mode.value === 'scripted';

connectButton.addEventListener('click', () => {
  setState('waiting');
  // The credentials stay in the form fields and this call. The page stores nothing.
  const shared = {
    clientId: clientId.value,
    onDiagnostic,
    onMessage: showMessage,
    onQosOneMessage: showMessage,
    onSessionEnd(event: SessionEnd) {
      log(results, event.kind === 'error' ? `session ended: ${describe(event.error)}` : 'session ended: disconnect', event.kind);
    },
    ...(username.value === '' ? {} : { username: username.value }),
    ...(password.value === '' ? {} : { password: password.value }),
    ...(willTopic.value === '' ? {} : { will: { topic: willTopic.value, payload: 'offline' } }),
  };
  const reconnect: ReconnectOptions = { initialDelayMs: 5000, onReconnect };
  let created: ReconnectingClient;
  if (mode.value === 'scripted') {
    const scripted = scriptedBroker();
    broker = scripted;
    created = createReconnectingClient((options) => createTransportClient(scripted.transport, options), shared, reconnect);
  } else {
    broker = undefined;
    created = createReconnectingClient(createBrowserClient, { ...shared, url: url.value }, reconnect);
  }
  client = created;
  stopWatching = watchPageLifecycle(created, { onReturn });
});

subscribeButton.addEventListener('click', () => {
  void (async () => {
    try {
      const level = qos(subscribeQos);
      const result = await session?.subscribe(filter.value, { qos: level });
      if (result !== undefined) subscribed.set(filter.value, level);
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
      await client?.disconnect({ drain: drain.checked, reasonCode: sendWill.checked ? 4 : 0 });
      log(results, `disconnected${sendWill.checked ? ' with the Will' : ''}`, 'ok');
    } catch (error) {
      log(results, `disconnect failed: ${describe(error)}`, 'error');
    }
  })();
});

retryButton.addEventListener('click', () => {
  if (client !== undefined) log(reconnects, `retryNow() returned ${String(client.retryNow())}`, 'info');
});

dropButton.addEventListener('click', () => {
  log(results, broker?.drop() === true ? 'dropped the scripted connection' : 'no scripted connection to drop', 'info');
});

setState('idle');
