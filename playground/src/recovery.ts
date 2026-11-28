import { isMqttError } from 'mqtt/browser';

/** Where a connection failure happened. */
export interface FailureContext {
  /** True for the scripted broker in the page, false for a broker over WebSocket. */
  readonly scripted: boolean;
  /** True when the page was loaded over HTTPS, where a browser opens no `ws://` connection to another host. */
  readonly securePage: boolean;
  /** True while the reconnecting client waits for its next attempt, false after it stopped. */
  readonly waiting: boolean;
}

/** A WebSocket URL the client cannot use, and the URL to use instead when one follows from the input. */
export interface UrlProblem {
  readonly message: string;
  readonly suggestion?: string;
}

const localBroker = 'ws://127.0.0.1:18900';
// MQTT 5 CONNACK reasons the reconnecting client retries: Server unavailable, Server busy, Quota exceeded, Connection rate exceeded.
const busyRefusals: ReadonlySet<number | undefined> = new Set([0x88, 0x89, 0x97, 0x9f]);

/** The reason a browser client cannot connect to `value`, or undefined for a `ws://` or `wss://` URL. */
export function urlProblem(value: string): UrlProblem | undefined {
  if (!URL.canParse(value))
    return { message: `"${value}" is not a URL. Enter the broker's WebSocket URL, such as ${localBroker}.` };
  const parsed = new URL(value);
  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') return undefined;
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const scheme = parsed.protocol === 'http:' ? 'ws://' : 'wss://';
    return {
      message: `The URL starts with ${parsed.protocol}//. A browser reaches MQTT over WebSocket, so use ws:// or wss://.`,
      suggestion: scheme + parsed.host + parsed.pathname + parsed.search,
    };
  }
  return {
    message: `A browser cannot open a ${parsed.protocol}// connection. Use the ws:// or wss:// listener of the broker, such as ${localBroker}.`,
  };
}

function cause(error: unknown, context: FailureContext): string {
  if (isMqttError(error, 'ERR_MQTT_REFUSED')) {
    if (error.reasonCode === 0x86 || error.reasonCode === 0x87) return 'Check the user name and the password.';
    if (error.reasonCode === 0x85) return 'The broker does not accept the client identifier. Change it.';
    if (busyRefusals.has(error.reasonCode)) return 'The broker is busy or over a limit.';
    return 'The broker refused the connection. Its log names the cause.';
  }
  if (isMqttError(error, 'ERR_MQTT_BROKER_DISCONNECT') && error.reasonCode === 0x8e)
    return 'Another client connected with this client identifier. Change the client identifier.';
  if (isMqttError(error, 'ERR_MQTT_TRANSPORT')) {
    if (context.scripted) return 'The scripted broker ended the connection.';
    const secure = context.securePage ? ' A page loaded over HTTPS needs a wss:// URL.' : '';
    return `Check that a broker listens at the WebSocket URL. Start a local one with "mosquitto -c playground/mosquitto.conf".${secure}`;
  }
  if (isMqttError(error, 'ERR_MQTT_TIMEOUT'))
    return 'The broker did not answer in time. Check that the URL is a listener for MQTT over WebSocket.';
  if (isMqttError(error, 'ERR_MQTT_INVALID_ARGUMENT')) return 'Correct the field that the message names.';
  return '';
}

/** What the user can do after a connection failure: the likely cause, then the control that tries again. */
export function recovery(error: unknown, context: Readonly<FailureContext>): string {
  const action = context.waiting
    ? 'The client tries again after the delay. Choose "Retry now" to try at once.'
    : 'Choose "Connect again" to start over.';
  return `${cause(error, context)} ${action}`.trim();
}
