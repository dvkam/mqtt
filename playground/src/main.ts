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
import { recovery, urlProblem } from './recovery.js';
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
const stateText = element('state', HTMLParagraphElement);
const recoverButton = element('recover', HTMLButtonElement);
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
const lists = {
  reconnects: element('reconnects', HTMLOListElement),
  results: element('results', HTMLOListElement),
  messages: element('messages', HTMLOListElement),
  diagnostics: element('diagnostics', HTMLOListElement),
};

type Kind = 'info' | 'ok' | 'error';
type State = 'idle' | 'waiting' | 'connected';

const scripted = scriptedBroker();
let client: ReconnectingClient | undefined;
let session: ClientSession | undefined;
let scriptedSession = false;
let stopWatching: (() => void) | undefined;
let recover: (() => void) | undefined;
const subscribed = new Map<string, 0 | 1>();
const decoder = new TextDecoder();

function log(list: keyof typeof lists, text: string, kind: Kind = 'info'): void {
  const item = document.createElement('li');
  item.textContent = text;
  item.dataset.kind = kind;
  lists[list].prepend(item);
}

function show(text: string, kind: Kind = 'info'): void {
  stateText.textContent = text;
  stateText.dataset.kind = kind;
}

/** A rejection as the page shows it: the stable code and whether the session ended, or the message for other errors. */
function describe(error: unknown): string {
  if (isMqttError(error)) {
    const reason = error.reasonCode === undefined ? '' : ` reason 0x${error.reasonCode.toString(16)}`;
    return `${error.code}${reason} fatal=${String(error.fatal)}: ${error.message}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function setState(state: State): void {
  const focused = document.activeElement;
  connectButton.disabled = state !== 'idle';
  subscribeButton.disabled = state !== 'connected';
  publishButton.disabled = state !== 'connected';
  disconnectButton.disabled = state === 'idle';
  dropButton.disabled = state !== 'connected' || !scriptedSession;
  retryButton.disabled = state === 'idle';
  // A browser drops the focus of a control that becomes disabled, so the focus moves to the control that undoes the state.
  if (focused instanceof HTMLButtonElement && focused.disabled) (state === 'idle' ? connectButton : disconnectButton).focus();
}

function offerRecovery(label: string, action: () => void): void {
  recover = action;
  recoverButton.textContent = label;
  recoverButton.hidden = false;
}

function withdrawRecovery(): void {
  const focused = document.activeElement === recoverButton;
  recover = undefined;
  recoverButton.hidden = true;
  if (focused) (connectButton.disabled ? disconnectButton : connectButton).focus();
}

function qos(value: string): 0 | 1 {
  return value === '1' ? 1 : 0;
}

function onDiagnostic(event: ClientDiagnostic): void {
  log('diagnostics', event.kind === 'packet' ? `${event.direction} ${event.command}` : `connection ${event.state}`);
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- onMessage and onQosOneMessage in browserClient.d.ts of the packed client deliver a PublishMessage, whose payload is a native Uint8Array.
function showMessage(message: BrowserMessage | BrowserQosOneMessage): void {
  const flags = `QoS ${String(message.qos)}${message.retain ? ', retained' : ''}`;
  log('messages', `${message.topic} [${flags}] ${decoder.decode(message.payload)}`);
}

function previousEnd(end: SessionEnd | undefined): string {
  if (end === undefined) return 'none';
  if (end.kind === 'disconnect') return 'disconnect';
  const uncertain = (end.uncertain ?? []).map(
    (publication) => `${publication.topic} #${String(publication.messageId)}${publication.acknowledged ? ' acknowledged' : ''}`,
  );
  return `${describe(end.error)}; uncertain publications: ${uncertain.length === 0 ? 'none' : uncertain.join(', ')}`;
}

async function subscribeAgain(current: Readonly<ClientSession>): Promise<void> {
  for (const [again, level] of subscribed) {
    try {
      await current.subscribe(again, { qos: level });
      log('results', `subscribed ${again} again after the reconnect`, 'ok');
    } catch (error) {
      log('results', `subscribe ${again} again failed: ${describe(error)}`, 'error');
    }
  }
}

function onReturn(event: PageReturn): void {
  log('reconnects', `page returned on ${event.trigger} after ${String(Math.round(event.awayMs))} ms: ${event.outcome}`);
}

function retryNow(): void {
  if (client !== undefined) log('reconnects', `retryNow() returned ${String(client.retryNow())}`);
}

function onReconnect(event: ReconnectEvent): void {
  switch (event.kind) {
    case 'connected':
      session = event.session;
      snapshot.textContent = JSON.stringify(event.session.connection, undefined, 2);
      log(
        'reconnects',
        `connected generation ${String(event.generation)} attempt ${String(event.attempt)}, previous end: ${previousEnd(event.previous)}`,
        'ok',
      );
      if (event.generation === 1) log('results', `connected as ${event.session.connection.clientId}`, 'ok');
      show(`Connected as ${event.session.connection.clientId}, session ${String(event.generation)}.`, 'ok');
      setState('connected');
      withdrawRecovery();
      if (event.generation > 1) void subscribeAgain(event.session);
      break;
    case 'puback':
      log(
        'reconnects',
        `PUBACK reason 0x${event.reasonCode.toString(16)} for ${event.topic} #${String(event.messageId)}, sent again after the resume`,
        event.reasonCode < 0x80 ? 'ok' : 'error',
      );
      break;
    case 'retrying': {
      session = undefined;
      snapshot.textContent = 'No session';
      const hint = recovery(event.error, { scripted: scriptedSession, securePage: location.protocol === 'https:', waiting: true });
      const delay = `attempt ${String(event.attempt)} in ${String(Math.round(event.delayMs))} ms`;
      log('reconnects', `retrying ${delay} after ${describe(event.error)}. ${hint}`, 'error');
      show(`Waiting to reconnect after "${event.error.message}", ${delay}. ${hint}`, 'error');
      setState('waiting');
      offerRecovery('Retry now', retryNow);
      break;
    }
    case 'stopped': {
      const hint =
        event.error === undefined
          ? ''
          : recovery(event.error, { scripted: scriptedSession, securePage: location.protocol === 'https:', waiting: false });
      stopWatching?.();
      stopWatching = undefined;
      client = undefined;
      session = undefined;
      scriptedSession = false;
      subscribed.clear();
      snapshot.textContent = 'No session';
      if (event.error === undefined) {
        log('reconnects', `stopped: ${event.reason}`);
        show('Not connected.');
      } else {
        log('reconnects', `stopped: ${event.reason} ${describe(event.error)}. ${hint}`, 'error');
        show(`Stopped after "${event.error.message}". ${hint}`, 'error');
      }
      setState('idle');
      if (event.error === undefined) withdrawRecovery();
      else offerRecovery('Connect again', connect);
      break;
    }
    default: {
      const unhandled: never = event;
      log('reconnects', `unhandled reconnect event ${JSON.stringify(unhandled)}`, 'error');
    }
  }
}

function connect(): void {
  scriptedSession = mode.value === 'scripted';
  const problem = scriptedSession ? undefined : urlProblem(url.value);
  if (problem !== undefined) {
    const { message, suggestion } = problem;
    url.setAttribute('aria-invalid', 'true');
    url.setAttribute('aria-describedby', 'state');
    log('results', `connect failed: ${message}`, 'error');
    show(message, 'error');
    if (suggestion === undefined) {
      withdrawRecovery();
      url.focus();
    } else
      offerRecovery(`Use ${suggestion}`, () => {
        url.value = suggestion;
        url.dispatchEvent(new Event('input'));
        connect();
      });
    return;
  }
  url.removeAttribute('aria-invalid');
  url.removeAttribute('aria-describedby');
  show('Connecting.');
  setState('waiting');
  withdrawRecovery();
  const shared = {
    clientId: clientId.value,
    onDiagnostic,
    onMessage: showMessage,
    onQosOneMessage: showMessage,
    onSessionEnd(event: SessionEnd) {
      if (event.kind === 'error') log('results', `session ended: ${describe(event.error)}`, 'error');
      else log('results', 'session ended: disconnect');
    },
    ...(username.value === '' ? {} : { username: username.value }),
    ...(password.value === '' ? {} : { password: password.value }),
    ...(willTopic.value === '' ? {} : { will: { topic: willTopic.value, payload: 'offline', retain: true } }),
  };
  const reconnect: ReconnectOptions = { initialDelayMs: 5000, onReconnect };
  const created = scriptedSession
    ? createReconnectingClient(
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- createReconnectingClient in reconnect.d.ts of the packed client passes the factory options, which hold a native AbortSignal and the Uint8Array message callbacks. createTransportClient takes the same type.
        (options) => createTransportClient(scripted.transport, options),
        shared,
        reconnect,
      )
    : createReconnectingClient(createBrowserClient, { ...shared, url: url.value }, reconnect);
  client = created;
  stopWatching = watchPageLifecycle(created, { onReturn });
}

const fieldsKeptAcrossReloads = [mode, url, clientId, willTopic, filter, subscribeQos, topic, publishQos];

function storable(field: string, value: string): boolean {
  if (field !== url.id) return true;
  if (!URL.canParse(value)) return false;
  const parsed = new URL(value);
  return parsed.username === '' && parsed.password === '' && parsed.search === '';
}

for (const field of fieldsKeptAcrossReloads) {
  const key = `playground.${field.id}`;
  try {
    const stored = sessionStorage.getItem(key);
    if (stored !== null) field.value = stored;
    if (field instanceof HTMLSelectElement && field.selectedIndex < 0) field.selectedIndex = 0;
  } catch {
    // A browser that blocks storage throws here, and the page then starts with its default values.
  }
  field.addEventListener('input', () => {
    try {
      if (storable(field.id, field.value)) sessionStorage.setItem(key, field.value);
      else sessionStorage.removeItem(key);
    } catch {
      // A browser that blocks storage throws here, and the page then keeps the value until it closes.
    }
  });
}

mode.addEventListener('change', () => {
  url.disabled = mode.value === 'scripted';
});
url.disabled = mode.value === 'scripted';

connectButton.addEventListener('click', connect);
recoverButton.addEventListener('click', () => {
  recover?.();
});

subscribeButton.addEventListener('click', () => {
  void (async () => {
    try {
      const level = qos(subscribeQos.value);
      const result = await session?.subscribe(filter.value, { qos: level });
      if (result !== undefined) subscribed.set(filter.value, level);
      log('results', `subscribed ${filter.value}: granted QoS ${String(result?.grantedQos)}`, 'ok');
    } catch (error) {
      log('results', `subscribe ${filter.value} failed: ${describe(error)}`, 'error');
    }
  })();
});

publishButton.addEventListener('click', () => {
  void (async () => {
    const level = qos(publishQos.value);
    try {
      await session?.publish(topic.value, payload.value, { qos: level, retain: retain.checked });
      log('results', `published ${topic.value} at QoS ${String(level)}${level === 1 ? ': PUBACK' : ''}`, 'ok');
    } catch (error) {
      log('results', `publish ${topic.value} failed: ${describe(error)}`, 'error');
    }
  })();
});

disconnectButton.addEventListener('click', () => {
  void (async () => {
    try {
      await client?.disconnect({ drain: drain.checked, reasonCode: sendWill.checked ? 4 : 0 });
      log('results', `disconnected${sendWill.checked ? ' with the Will' : ''}`, 'ok');
    } catch (error) {
      log('results', `disconnect failed: ${describe(error)}`, 'error');
    }
  })();
});

retryButton.addEventListener('click', retryNow);

dropButton.addEventListener('click', () => {
  log('results', scripted.drop() ? 'dropped the scripted connection' : 'no scripted connection to drop');
});

setState('idle');
