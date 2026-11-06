import {
  IConnackPacket,
  IConnectPacket,
  IDisconnectPacket,
  IPublishPacket,
  Packet,
  parser as mqttParser,
  Parser as MqttParser,
} from 'mqtt-packet';
import { write } from './write.js';
import { ConnectOptions } from './interface/connectOptions.js';
import { Duplex } from 'node:stream';
import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { connectionFactory } from './connectionFactory/index.js';
import { defaultConnectOptions } from './util/constants.js';
import { ReasonCodes } from './util/reasonCodes.js';
import { ReturnCodes } from './util/returnCodes.js';
import { logger } from './util/logger.js';
import { defaultClientId } from './util/defaultClientId.js';
import { Logger } from 'pino';
import { MqttPacketSequencer } from './sequencer.js';

type PublishPacket = Pick<IPublishPacket, 'topic'> &
  Partial<Pick<IPublishPacket, 'payload' | 'retain' | 'properties'>> & { qos?: 0 };

export class MqttClient extends EventEmitter {
  _incomingPacketParser: MqttParser;
  _options: ConnectOptions;
  disconnecting: any;
  connecting: boolean;
  connected: boolean;
  errored: boolean;
  conn: Duplex | Socket;
  _clientLogger: Logger;
  private readonly _packetSequencer = new MqttPacketSequencer((packet) => write(this, packet));

  constructor(options: ConnectOptions) {
    super();
    // assume the options have been validated before instantiating the client.
    this.connecting = false;
    this.connected = false;
    this.errored = false;
    this.disconnecting = false;

    // Using this method to clean up the constructor to do options handling
    logger.trace(`populating internal client options object...`);
    this._options = {
      clientId: defaultClientId(),
      ...defaultConnectOptions,
      ...options,
    };

    this._clientLogger = logger.child({ id: this._options.clientId });

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
    this._incomingPacketParser.on('packet', this.handleIncomingPacket.bind(this));

    // Echo connection errors this.emit('clientError')
    // We could look at maybe pushing errors in different directions depending on how we should
    // respond to the different errors.
    this._incomingPacketParser.on('error', (err: any) => {
      this._clientLogger.error(`error in incomingPacketParser.`);
      this.emit('clientError', err);
    });

    this.once('connected', () => {
      this._clientLogger.trace(`client is connected.`);
    });
    this.on('close', () => {
      this._clientLogger.trace(`client is closed.`);
      this.connected = false;
    });

    this.conn.on('readable', () => {
      this._clientLogger.trace(`data available to be read from the 'conn' stream...`);
      let data = this.conn.read();

      while (data) {
        this._clientLogger.trace(`process the data..`);
        // process the data
        this._incomingPacketParser.parse(data);
        data = this.conn.read();
      }
    });

    this.on('clientError', this.onError);
    this.conn.on('error', this.emit.bind(this, 'clientError'));

    this.conn.on('close', () => {
      this.connected = false;
      this._packetSequencer.cancelConnect(new Error('Connection closed before CONNACK'));
    });
  }

  async handleIncomingPacket(packet: Packet): Promise<void> {
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
      clientId: this._options.clientId as string,
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
  public async publish(packet: PublishPacket): Promise<void> {
    if (!this.connected) {
      throw new Error('client must be connected to publish.');
    }
    if (packet.qos !== undefined && packet.qos !== 0) throw new Error('Only QoS 0 publishing is supported');
    await write(this, {
      ...packet,
      cmd: 'publish',
      qos: 0,
      dup: false,
      retain: packet.retain ?? false,
      payload: packet.payload ?? '',
    });
  }

  private async _destroyClient(force?: boolean) {
    this._clientLogger.trace(`destroying client...`);
    this.conn.removeAllListeners('error');
    this.conn.removeAllListeners('close');
    this.conn.on('close', () => {});
    this.conn.on('error', () => {});

    if (force) {
      this._clientLogger.trace(`force destroying the underlying connection stream...`);
      this.conn.destroy();
    } else {
      this._clientLogger.trace(`gracefully ending the underlying connection stream...`);
      this.conn.end(() => {
        this._clientLogger.trace('END all data has been flushed from stream.');
      });
      // once the stream.end() method has been called, and all the data has been flushed to the underlying system, the 'finish' event is emitted.
      this.conn.once('finish', () => {
        this._clientLogger.trace('all data has been flushed from stream.');
      });
    }
    return this;
  }

  public async disconnect({ force, options = {} }: { force?: boolean; options?: any } = {}): Promise<MqttClient> {
    // if client is already disconnecting, do nothing.
    if (this.disconnecting) {
      this._clientLogger.trace(`client already disconnecting.`);
      return this;
    }

    //
    this.disconnecting = true;

    this._clientLogger.trace('disconnecting client...');
    const packet: IDisconnectPacket = {
      cmd: 'disconnect',
      reasonCode: options.reasonCode,
      properties: options.properties,
    };
    this._clientLogger.trace('writing disconnect...');
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

  private _onConnected(packet: IConnackPacket) {
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
  onError(err?: Error | null | undefined) {
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
    const state = (this.conn as any)._writableState;
    if (typeof state.getBuffer !== 'function') {
      // See https://github.com/nodejs/node/pull/31165
      throw new Error('_writableState.buffer is EOL. _writableState should have getBuffer() as a function.');
    }
    const list: any[] = state.getBuffer();
    list.forEach((req) => {
      req.callback();
    });
  }
}
