import {
  type IConnackPacket,
  type IConnectPacket,
  type IDisconnectPacket,
  type IPublishPacket,
  type Packet,
  parser as mqttParser,
  type Parser as MqttParser,
} from 'mqtt-packet';
import { write } from './write.js';
import type { ConnectOptions } from './interface/connectOptions.js';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { connectionFactory } from './connectionFactory/index.js';
import { defaultConnectOptions } from './util/constants.js';
import { ReasonCodes } from './util/reasonCodes.js';
import { ReturnCodes } from './util/returnCodes.js';
import { defaultClientId } from './util/defaultClientId.js';
import { MqttPacketSequencer } from './sequencer.js';

type PublishPacket = Pick<IPublishPacket, 'topic'> &
  Partial<Pick<IPublishPacket, 'payload' | 'retain' | 'properties'>> & { qos?: 0 };

function hasBufferedWrites(value: unknown): value is { getBuffer(): unknown } {
  return typeof value === 'object' && value !== null && 'getBuffer' in value && typeof value.getBuffer === 'function';
}

function hasWriteCallback(value: unknown): value is { callback(): void } {
  return typeof value === 'object' && value !== null && 'callback' in value && typeof value.callback === 'function';
}

export class MqttClient extends EventEmitter {
  _incomingPacketParser: MqttParser;
  _options: ConnectOptions;
  disconnecting: boolean;
  connecting: boolean;
  connected: boolean;
  errored: boolean;
  conn: Duplex | Socket;
  // oxlint-disable-next-line typescript/promise-function-async, typescript/prefer-readonly-parameter-types -- Forward the existing promise without adding an async wrapper. The legacy client retains native stream state and shared packet buffers.
  private readonly _packetSequencer = new MqttPacketSequencer((packet) => write(this, packet));

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The legacy client retains native stream state and shared packet buffers.
  constructor(options: Readonly<ConnectOptions>) {
    super();
    // assume the options have been validated before instantiating the client.
    this.connecting = false;
    this.connected = false;
    this.errored = false;
    this.disconnecting = false;

    // Using this method to clean up the constructor to do options handling
    this._options = {
      clientId: defaultClientId(),
      ...defaultConnectOptions,
      ...options,
    };

    this.conn = this._options.customStreamFactory
      ? this._options.customStreamFactory(this._options)
      : connectionFactory(this._options);

    // many drain listeners are needed for qos 1 callbacks if the connection is intermittent
    this.conn.setMaxListeners(1000);

    this._incomingPacketParser = mqttParser(this._options);

    // Handle incoming packets this are parsed
    // NOTE: This is only handling incoming packets from the
    // readable stream of the conn stream.
    // we need to make sure that the function called on 'packet' is bound to the context of 'MQTTClient'
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The legacy client retains native stream state and shared packet buffers.
    this._incomingPacketParser.on('packet', (packet) => {
      void this.handleIncomingPacket(packet).catch((error: unknown) => {
        this.emit('clientError', error);
      });
    });

    // Echo connection errors this.emit('clientError')
    // We could look at maybe pushing errors in different directions depending on how we should
    // respond to the different errors.
    this._incomingPacketParser.on('error', (err: unknown) => {
      this.emit('clientError', err);
    });

    this.on('close', () => {
      this.connected = false;
    });

    this.conn.on('readable', () => {
      let data: unknown = this.conn.read();

      while (data !== null && data !== undefined) {
        // process the data
        if (Buffer.isBuffer(data)) {
          this._incomingPacketParser.parse(data);
        } else if (typeof data === 'string') {
          this._incomingPacketParser.parse(Buffer.from(data));
        } else if (data instanceof Uint8Array) {
          this._incomingPacketParser.parse(Buffer.from(data));
        } else {
          this.emit('clientError', new Error('MQTT transport requires byte chunks'));
          return;
        }
        data = this.conn.read();
      }
    });

    this.on('clientError', this.onError.bind(this));
    this.conn.on('error', (error: unknown) => {
      this.emit('clientError', error);
    });

    this.conn.on('close', () => {
      this.connected = false;
      this._packetSequencer.cancelConnect(new Error('Connection closed before CONNACK'));
    });
  }

  // oxlint-disable-next-line typescript/require-await, typescript/prefer-readonly-parameter-types -- Callers observe packet-handler failures through the promise API. The legacy client retains native stream state and shared packet buffers.
  async handleIncomingPacket(packet: Readonly<Packet>): Promise<void> {
    this._packetSequencer.handleIncomingPacket(packet);
  }

  /**
   * connect
   * @param options
   * @returns
   */
  // TODO: Should this be moved up to the index.ts file, or should it live here?
  public async connect(): Promise<IConnackPacket> {
    if (this.connecting || this.connected) throw new Error('Client is already connecting or connected');
    this.connecting = true;
    const packet: IConnectPacket = {
      cmd: 'connect',
      clientId: this._options.clientId ?? '',
      protocolVersion: this._options.protocolVersion,
      protocolId: this._options.protocolId,
      clean: this._options.clean,
      keepalive: this._options.keepalive,
      username: this._options.username,
      password: this._options.password,
      will: this._options.will,
      properties: this._options.properties,
    };
    try {
      const connack = await this._packetSequencer.connect(packet, this._options.connectTimeout);
      this._onConnected(connack);
      return connack;
    } catch (error) {
      this.conn.destroy();
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  /**
   * publish - publish <message> to <topic>
   * Currently only supports QoS 0 Publish
   *
   * @param {PublishPacket} packet - publish packet
   * @returns {Promise<void>} - Promise will be resolved
   * when the message has been sent, but not acked.
   */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The legacy client retains native stream state and shared packet buffers.
  public async publish(packet: Readonly<PublishPacket>): Promise<void> {
    if (!this.connected) {
      throw new Error('client must be connected to publish.');
    }
    const requestedQualityOfService: unknown = packet.qos;
    if (requestedQualityOfService !== undefined && requestedQualityOfService !== 0)
      throw new Error('Only QoS 0 publishing is supported');
    await write(this, {
      ...packet,
      cmd: 'publish',
      qos: 0,
      dup: false,
      retain: packet.retain ?? false,
      payload: packet.payload ?? '',
    });
  }

  private _destroyClient(force?: boolean) {
    this.conn.removeAllListeners('error');
    this.conn.removeAllListeners('close');
    this.conn.on('close', () => {});
    this.conn.on('error', () => {});

    if (force === true) {
      this.conn.destroy();
    } else {
      this.conn.end();
    }
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The legacy client retains native stream state and shared packet buffers.
  public async disconnect({
    force,
    options = {},
  }: Readonly<{ force?: boolean; options?: Pick<IDisconnectPacket, 'reasonCode' | 'properties'> }> = {}): Promise<this> {
    // if client is already disconnecting, do nothing.
    if (this.disconnecting) {
      return this;
    }

    //
    this.disconnecting = true;

    const packet: IDisconnectPacket = {
      cmd: 'disconnect',
      reasonCode: options.reasonCode,
      properties: options.properties,
    };
    // close the network connection
    // ensure NO control packets are sent on the network connection.
    // disconnect packet is the final control packet sent from the client to the server. It indicates the client is disconnecting cleanly.
    await write(this, packet);

    // once write is done, then switch state to disconnected
    this.connected = false;
    this.connecting = false;
    this._destroyClient(force);
    return this;
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The legacy client retains native stream state and shared packet buffers.
  private _onConnected(packet: Readonly<IConnackPacket>) {
    const isMqtt5 = this._options.protocolVersion === 5;
    const code = isMqtt5 ? packet.reasonCode : packet.returnCode;
    if (typeof code !== 'number') throw new Error('Invalid connack packet');

    if (code !== 0) {
      const messages: Partial<Record<number, string>> = isMqtt5 ? ReasonCodes.connack : ReturnCodes.connack;
      const message = messages[code]?.replace(/^Connection Refused: /, '') ?? String(code);
      throw Object.assign(new Error('Connection refused: ' + message), { code });
    }

    this.connected = true;
  }

  // TODO: follow up on Aedes to see if there is a better way than breaking the Node Streams contract and accessing _writableState
  // to make sure that the write callback is cleaned up in case of error.
  onError(err?: Readonly<Error | null>) {
    if (this.connecting) {
      this._packetSequencer.cancelConnect(err ?? new Error('Connection failed'));
      return;
    }
    this.emit('error', err);
    this.errored = true;
    this.conn.removeAllListeners('error');
    this.conn.on('error', () => {});
    // hack to clean up the write callbacks in case of error
    this.hackyCleanupWriteCallback();
    this._destroyClient(true);
  }

  hackyCleanupWriteCallback() {
    // _writableState is not part of the public API for Duplex or Socket, so we have to do some typecasting here to work with it as the stream state.
    // See https://github.com/nodejs/node/issues/445 for information on this.
    const connection = this.conn;
    const state: unknown = '_writableState' in connection ? connection._writableState : undefined;
    if (!hasBufferedWrites(state)) {
      // See https://github.com/nodejs/node/pull/31165
      throw new Error('_writableState.buffer is EOL. _writableState should have getBuffer() as a function.');
    }
    const pendingWrites: unknown = state.getBuffer();
    if (!Array.isArray(pendingWrites)) throw new Error('Invalid writable buffer state');
    const requests: unknown[] = pendingWrites;
    for (const request of requests) {
      if (!hasWriteCallback(request)) throw new Error('Invalid writable callback');
      request.callback();
    }
  }
}
