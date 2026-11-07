export interface ClientSession {
  subscribe(topic: string): Promise<void>;
  publish(topic: string, payload: string): Promise<void>;
  ping(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ClientFactory {
  connect(): Promise<ClientSession>;
}
