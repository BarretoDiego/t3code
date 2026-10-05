import type { DiscoveredProjectScript } from "@t3tools/contracts";
import { parse as parseYaml } from "yaml";

export const SCRIPT_MANIFEST_NAMES = new Set([
  "package.json",
  "task.yaml",
  "task.yml",
  "taskfile.yaml",
  "taskfile.yml",
  "taskfile.dist.yaml",
  "taskfile.dist.yml",
]);

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
export const PACKAGE_MANAGER_LOCKS = new Map([
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function packageManagerFromManifest(contents: string): string | null {
  try {
    const value = record(JSON.parse(contents));
    const manager =
      typeof value?.packageManager === "string" ? value.packageManager.split("@")[0]! : "";
    return PACKAGE_MANAGERS.has(manager) ? manager : null;
  } catch {
    return null;
  }
}

/** Quote a terminal argument for POSIX shells or the Windows PowerShell terminal. */
function quote(value: string, platform: string): string {
  if (/^[a-zA-Z0-9_.:@/+-]+$/.test(value) && !value.startsWith("-")) return value;
  return platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Read declarations only; discovering a Taskfile never executes its commands or templates. */
export function scriptsFromManifest(input: {
  sourcePath: string;
  contents: string;
  packageManager: string;
  platform: string;
}): DiscoveredProjectScript[] {
  const segments = input.sourcePath.split("/");
  const filename = segments.pop()!;
  const cwd = segments.join("/") || ".";
  const isPackage = filename === "package.json";
  const manifest = record(isPackage ? JSON.parse(input.contents) : parseYaml(input.contents));
  const declarations = record(manifest?.[isPackage ? "scripts" : "tasks"]);
  if (!manifest || !declarations) return [];
  return Object.entries(declarations).flatMap(([name, value]) => {
    if (!name.trim() || name.length > 256 || /[\r\n\0]/.test(name) || name.startsWith("-"))
      return [];
    const task = record(value);
    if (isPackage ? typeof value !== "string" || !value.trim() : task?.internal === true) {
      return [];
    }
    if (!isPackage && typeof value !== "string" && !Array.isArray(value) && !task) return [];
    const description = isPackage ? String(value) : task?.desc;
    return [
      {
        name,
        cwd,
        sourcePath: input.sourcePath,
        command: isPackage
          ? `${input.packageManager} run ${quote(name, input.platform)}`
          : `task --taskfile ${quote(filename, input.platform)} ${quote(name, input.platform)}`,
        ...(typeof description === "string" ? { description: description.slice(0, 512) } : {}),
      },
    ];
  });
}
