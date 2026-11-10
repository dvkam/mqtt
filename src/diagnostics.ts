const commands = [
  'auth',
  'connack',
  'connect',
  'disconnect',
  'pingreq',
  'pingresp',
  'puback',
  'pubcomp',
  'publish',
  'pubrel',
  'pubrec',
  'suback',
  'subscribe',
  'unsuback',
  'unsubscribe',
] as const;

type Command = (typeof commands)[number];
type Direction = 'inbound' | 'outbound';
const allowedCommands: ReadonlySet<string> = new Set(commands);

export type ClientDiagnostic =
  | Readonly<{ kind: 'packet'; direction: Direction; command: Command }>
  | Readonly<{ kind: 'connection'; state: 'active' | 'retired' }>;

export type DiagnosticObserver = (event: ClientDiagnostic) => void | Promise<void>;

export async function notifyObserver<Event>(observer: (event: Event) => void | Promise<void>, event: Event): Promise<void> {
  try {
    await observer(event);
  } catch {
    // Observer failures cannot replace a protocol result.
  }
}

function reportPacket(observer: DiagnosticObserver, direction: Direction, command: Command): void {
  if (allowedCommands.has(command)) void notifyObserver(observer, { kind: 'packet', direction, command });
}

export function packetSender<Packet extends Readonly<{ cmd: Command }>, Result>(
  transport: Readonly<{ send(packet: Packet): Result }>,
  observer: DiagnosticObserver | undefined,
): (packet: Packet) => Result {
  if (observer === undefined) return (packet) => transport.send(packet);
  return (packet) => {
    const { cmd } = packet;
    const sent = transport.send(packet);
    reportPacket(observer, 'outbound', cmd);
    return sent;
  };
}

export function packetReceiver<Packet extends Readonly<{ cmd: Command }>>(
  receive: (packet: Packet) => void,
  observer: DiagnosticObserver | undefined,
  listening: () => boolean,
): (packet: Packet) => void {
  if (observer === undefined) return receive;
  return (packet) => {
    if (!listening()) return;
    const { cmd } = packet;
    receive(packet);
    reportPacket(observer, 'inbound', cmd);
  };
}
