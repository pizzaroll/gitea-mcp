import { ConfigSchema, type Config, type GiteaInstance } from '../types/config.js';

// Configuration is authoritative. Never log environment strings or fall back to embedded credentials.
export function loadConfig(): Config {
  try {
    const config = ConfigSchema.parse({
      server: { logLevel: process.env.LOG_LEVEL, environment: process.env.NODE_ENV },
      gitea: { instances: JSON.parse(process.env.GITEA_INSTANCES || '[]') as unknown,
        defaultTimeout: Number(process.env.GITEA_TIMEOUT || '30000'),
        maxRetries: Number(process.env.GITEA_MAX_RETRIES || '3') },
      upload: { maxFileSize: Number(process.env.MAX_FILE_SIZE || '10485760'),
        maxFiles: Number(process.env.MAX_FILES || '100'), batchSize: Number(process.env.BATCH_SIZE || '10') }
    });
    const ids = new Set<string>();
    for (const instance of config.gitea.instances) {
      if (!instance.id || !instance.token || ids.has(instance.id) || !Number.isSafeInteger(instance.timeout) ||
        instance.timeout < 1 || instance.timeout > 120000 || !Number.isSafeInteger(instance.rateLimit.requests) ||
        instance.rateLimit.requests < 1 || !Number.isSafeInteger(instance.rateLimit.windowMs) || instance.rateLimit.windowMs < 1) {
        throw new Error('Invalid instance configuration');
      }
      const url = new URL(instance.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Invalid instance URL');
      }
      ids.add(instance.id);
    }
    return config;
  } catch {
    throw new Error('Invalid Gitea configuration. Supply valid GITEA_INSTANCES and configuration values; credentials are never defaulted.');
  }
}
export type { Config, GiteaInstance };
