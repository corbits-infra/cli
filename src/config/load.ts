import fs from "node:fs/promises";
import { getConfigPath } from "./path.js";
import {
  type CorbitsConfig,
  type EffectiveConfig,
  ConfigError,
  parseConfig,
  resolveEffectiveConfig,
} from "./schema.js";

export type LoadedConfig = {
  path: string;
  config: CorbitsConfig;
  effective: EffectiveConfig;
};

export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedConfig | null> {
  const path = getConfigPath(env);

  try {
    const text = await fs.readFile(path, "utf8");
    const config = parseConfig(text);
    return {
      path,
      config,
      effective: resolveEffectiveConfig(config),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function loadRequiredConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedConfig> {
  const loaded = await loadConfig(env);
  if (loaded == null) {
    throw new ConfigError(
      "Config is not initialized. Run `corbits config init --network <name> --address <addr> --keyfile <path>`",
    );
  }
  return loaded;
}
