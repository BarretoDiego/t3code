// @effect-diagnostics nodeBuiltinImport:off - Asset export runs before the application runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import sharp from "sharp";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const root = new URL("../", import.meta.url);
const icon = await NodeFSP.readFile(new URL("assets/fork/icon.svg", root));
const mark = await NodeFSP.readFile(new URL("assets/fork/mark.svg", root));
const save = async (name: string, contents: Buffer) =>
  NodeFSP.writeFile(new URL(name, root), contents);
const png = (source: Buffer, size: number) => sharp(source).resize(size, size).png().toBuffer();

await save("assets/fork/icon-1024.png", await png(icon, 1024));
// macOS uses its own inset silhouette; Android gets full bleed and applies its own mask.
const rounded = Buffer.from(
  '<svg width="824" height="824"><rect width="824" height="824" rx="184" fill="white"/></svg>',
);
const macBody = await sharp(await png(icon, 824))
  .composite([{ input: rounded, blend: "dest-in" }])
  .png()
  .toBuffer();
await save(
  "assets/fork/icon-macos-1024.png",
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "transparent" } })
    .composite([{ input: macBody, left: 100, top: 100 }])
    .png()
    .toBuffer(),
);
await save(
  "assets/fork/icon-windows.ico",
  encodePngIco(
    await Promise.all(
      WINDOWS_ICON_SIZES.map(async (size) => ({
        size,
        contents: await png(icon, size),
      })),
    ),
  ),
);
await save("apps/mobile/assets/android-icon-foreground-fork.png", await png(mark, 432));
const background = icon.toString().replace(/<g[\s\S]*<\/svg>/, "</svg>");
await save(
  "apps/mobile/assets/android-icon-background-fork.png",
  await png(Buffer.from(background), 432),
);
await save("apps/mobile/assets/android-splash-icon-fork.png", await png(icon, 1152));
await save("apps/mobile/assets/android-icon-mark-fork.png", await png(mark, 432));
await save("assets/fork/favicon-16x16.png", await png(icon, 16));
await save("assets/fork/favicon-32x32.png", await png(icon, 32));
await save("assets/fork/apple-touch-icon.png", await png(icon, 180));
await save(
  "assets/fork/favicon.ico",
  encodePngIco(
    await Promise.all([16, 32].map(async (size) => ({ size, contents: await png(icon, size) }))),
  ),
);
await Effect.runPromise(
  Console.log(`Exported fork icons in ${NodeURL.fileURLToPath(new URL("assets/fork/", root))}`),
);
