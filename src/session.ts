export type PublishOptions = { qos?: 0; signal?: never } | { qos: 1; signal?: AbortSignal };

export interface ClientSession {
  subscribe(topic: string): Promise<void>;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The cancellation signal retains its native identity.
  publish(topic: string, payload: string, options?: Readonly<PublishOptions>): Promise<void>;
  ping(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ClientFactory {
  connect(): Promise<ClientSession>;
}
