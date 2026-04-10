import os from "node:os";
import path from "node:path";

export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "corbits", "config.toml");
}

export function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
