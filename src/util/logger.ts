import { pino } from 'pino';

// Used by the legacy sample scripts. The client does not import this logger.
export const logger = pino({ name: 'mqtt', level: 'silent', customLevels: { test: 35 } });
