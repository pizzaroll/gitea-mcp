import { ConfigSchema, type Config, type GiteaInstance } from '../types/config.js';
import { logger } from '../utils/logging.js';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(): Config {
  const rawInstances = process.env.GITEA_INSTANCES;
  if (!rawInstances) {
    throw new Error('GITEA_INSTANCES is required; credentials must be provided through runtime configuration');
  }

  let instances: unknown;
  try {
    instances = JSON.parse(rawInstances);
  } catch {
    throw new Error('GITEA_INSTANCES must be valid JSON');
  }

  const config = ConfigSchema.parse({
    server: {
      logLevel: process.env.LOG_LEVEL || 'info',
      environment: process.env.NODE_ENV || 'development'
    },
    gitea: {
      instances,
      defaultTimeout: envInt('GITEA_TIMEOUT', 30_000),
      maxRetries: envInt('GITEA_MAX_RETRIES', 3)
    },
    upload: {
      maxFileSize: envInt('MAX_FILE_SIZE', 10 * 1024 * 1024),
      maxFiles: envInt('MAX_FILES', 100),
      batchSize: envInt('BATCH_SIZE', 10)
    }
  });

  logger.debug('Loaded Gitea configuration', {
    instanceCount: config.gitea.instances.length,
    instanceIds: config.gitea.instances.map(instance => instance.id),
    environment: config.server.environment
  });

  return config;
}

export type { Config, GiteaInstance };
