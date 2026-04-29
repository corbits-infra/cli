import path from "node:path";

export function isStdoutTarget(targetPath: string | null | undefined): boolean {
  return targetPath == null || targetPath === "-";
}

export function hasFileOutputTarget(
  targetPath: string | null | undefined,
): targetPath is string {
  return targetPath != null && targetPath.length > 0 && targetPath !== "-";
}

export function createSiblingTempPrefix(targetPath: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.corbits-call-`,
  );
}
