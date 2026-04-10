import fs from "node:fs/promises";
import path from "node:path";
import { parseConfig, type CorbitsConfig, stringifyConfig } from "./schema.js";

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

  // Validate before touching the on-disk config so a bad mutation cannot brick
  // later commands that depend on loading the file.
  parseConfig(body);

  await fs.writeFile(tempPath, body, { mode: 0o600 });
  await fs.rename(tempPath, configPath);
}
