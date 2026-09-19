import { pino } from 'pino';

// stdout belongs exclusively to the MCP stdio transport in every environment.
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
  redact: { paths: ['token', 'password', 'authorization', '*.token', '*.password', '*.authorization'],
    censor: '[REDACTED]' }
}, pino.destination(2));
