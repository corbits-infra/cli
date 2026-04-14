import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type CorbitsConfig,
  ConfigError,
  parseConfig,
  resolveConfig,
  type ResolvedConfig,
  stringifyConfig,
} from "./schema.js";

export type LoadedConfig = {
  path: string;
  config: CorbitsConfig;
  resolved: ResolvedConfig;
};

export function getConfigPath(configPath?: string): string {
  if (configPath != null) return configPath;
  const base =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "corbits", "config.toml");
}

export async function loadConfig(
  configPath?: string,
): Promise<LoadedConfig | null> {
  const resolvedPath = getConfigPath(configPath);

  try {
    const text = await fs.readFile(resolvedPath, "utf8");
    const stat = await fs.stat(resolvedPath);
    if ((stat.mode & 0o077) !== 0) {
      process.stderr.write(
        `Warning: ${resolvedPath} has insecure permissions (${(stat.mode & 0o777).toString(8)}). Run: chmod 600 ${resolvedPath}\n`,
      );
    }
    const config = parseConfig(text);
    return {
      path: resolvedPath,
      config,
      resolved: resolveConfig(config),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(
      `Failed to read config at ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function loadRequiredConfig(
  configPath?: string,
): Promise<LoadedConfig> {
  const loaded = await loadConfig(configPath);
  if (loaded == null) {
    throw new ConfigError(
      "Config is not initialized, so `corbits config set` cannot update it yet. First run `corbits config init --network <name> --solana-address <addr> --solana-path <path>` (or the matching EVM flags, plus optional `--rpc-url <url>`) to create the config, then rerun your `corbits config set ...` command.",
    );
  }

  return loaded;
}

export async function saveConfig(
  configPath: string,
  config: CorbitsConfig,
): Promise<void> {
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true });

  const tempPath = path.join(
    dir,
    `.config.toml.tmp-${process.pid}-${Date.now().toString(36)}`,
  );
  const body = stringifyConfig(config);

  parseConfig(body);

  await fs.writeFile(tempPath, body, { mode: 0o600 });
  try {
    await fs.rename(tempPath, configPath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw err;
  }
}
