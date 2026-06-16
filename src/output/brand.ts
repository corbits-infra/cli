const ESC = "\u001b[";

const colors = {
  canvasCream: [228, 213, 188],
  breakthroughOrange: [233, 132, 40],
  terminalRed: [220, 84, 72],
} as const;

type RGB = readonly [number, number, number];
type ColorKind = keyof typeof colors;

function supportsColor(stream: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR != null) {
    return false;
  }
  if (
    process.env.FORCE_COLOR != null &&
    process.env.FORCE_COLOR !== "0" &&
    process.env.FORCE_COLOR.toLowerCase() !== "false"
  ) {
    return true;
  }
  if (process.env.TERM === "dumb") {
    return false;
  }
  return stream.isTTY ?? false;
}

export function isBrandOutputEnabled(
  stream: NodeJS.WriteStream = process.stdout,
): boolean {
  return supportsColor(stream);
}

function wrap(
  code: string,
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  return isBrandOutputEnabled(stream) ? `${ESC}${code}m${text}${ESC}0m` : text;
}

function color(
  rgb: RGB,
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  return wrap(`38;2;${rgb[0]};${rgb[1]};${rgb[2]}`, text, stream);
}

function bold(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  return wrap("1", text, stream);
}

export function brandColor(
  kind: ColorKind,
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  return color(colors[kind], text, stream);
}

export function brandAccent(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  return brandColor("breakthroughOrange", text, stream);
}

export function brandInfo(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  return brandColor("canvasCream", text, stream);
}

export function brandSuccess(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  return brandInfo(text, stream);
}

export function brandDanger(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  return brandColor("terminalRed", text, stream);
}

export function brandMuted(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  return wrap("2", text, stream);
}

export function brandStrong(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  return bold(text, stream);
}

function brandDisplayText(text: string): string {
  return text.toLocaleUpperCase("en-US");
}

export function formatSectionTitle(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  if (!isBrandOutputEnabled(stream)) {
    return text;
  }

  const title = brandDisplayText(text);
  const underline = "-".repeat(Math.max(12, title.length));
  return [
    brandStrong(brandAccent(title, stream), stream),
    brandInfo(underline, stream),
  ].join("\n");
}

export function formatTableHead(head: string[]): string[] {
  if (!isBrandOutputEnabled()) {
    return head;
  }

  return head.map((value) => brandStrong(brandInfo(value)));
}

export function formatStatus(
  text: string,
  tone: "info" | "success" | "danger" = "info",
  stream: NodeJS.WriteStream = process.stdout,
): string {
  if (tone === "success") {
    return brandSuccess(text, stream);
  }
  if (tone === "danger") {
    return brandDanger(text, stream);
  }
  return brandInfo(text, stream);
}

export function formatKeyValue(
  label: string,
  value: string,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  if (!isBrandOutputEnabled(stream)) {
    return `${label}: ${value}`;
  }
  const padded = `${brandDisplayText(label)}:`.padEnd(24, " ");
  return `${brandInfo(padded, stream)}${value}`;
}

export function formatPromptChoice(
  stream: NodeJS.WriteStream = process.stderr,
): string {
  if (!isBrandOutputEnabled(stream)) {
    return "[y/N]";
  }
  return `[${brandAccent("y", stream)}/${brandDanger("N", stream)}]`;
}

export function formatProgressNote(
  message: string,
  stream: NodeJS.WriteStream = process.stderr,
): string {
  if (/^(Using|Created|Paid|Payment complete)/.test(message)) {
    return brandInfo(message, stream);
  }
  if (/^(Creating|Topping up|Top up|Create)/.test(message)) {
    return brandAccent(message, stream);
  }
  return brandInfo(message, stream);
}

const corbitsAscii = [
  "  ____           _     _ _       ",
  " / ___|___  _ __| |__ (_) |_ ___ ",
  "| |   / _ \\| '__| '_ \\| | __/ __|",
  "| |__| (_) | |  | |_) | | |_\\__ \\",
  " \\____\\___/|_|  |_.__/|_|\\__|___/",
] as const;

export function printBrandHeader(_subtitle?: string): void {
  if (!isBrandOutputEnabled()) {
    return;
  }

  process.stdout.write(`${brandAccent(corbitsAscii.join("\n"))}\n`);
  process.stdout.write("\n");
}
