import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE } from '../config.js';
import { logger } from './logger.js';

class FeatureFlagManager {
  private flags: Record<string, unknown> = {};
  private readonly cachePath = path.join(path.dirname(CONFIG_FILE), 'feature-flags.json');

  async initialize(): Promise<void> {
    try {
      if (existsSync(this.cachePath)) {
        const cached = JSON.parse(await fs.readFile(this.cachePath, 'utf8')) as { flags?: Record<string, unknown> };
        this.flags = cached.flags ?? {};
      }
      logger.info('Local feature flags initialized');
    } catch {
      this.flags = {};
    }
  }

  get(flagName: string, defaultValue: unknown = false): unknown {
    return this.flags[flagName] ?? defaultValue;
  }

  getAll(): Record<string, unknown> {
    return { ...this.flags };
  }

  async refresh(): Promise<boolean> {
    return true;
  }

  wasLoadedFromCache(): boolean {
    return Object.keys(this.flags).length > 0;
  }

  async waitForFreshFlags(): Promise<void> {}

  destroy(): void {}
}

export const featureFlagManager = new FeatureFlagManager();
