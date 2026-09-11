// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

function isInside(root: string, target: string) {
  const relative = NodePath.relative(root, target);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
}

async function* links(directory: string): AsyncGenerator<string> {
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    const filename = NodePath.join(directory, entry.name);
    if (entry.isSymbolicLink()) yield filename;
    else if (entry.isDirectory()) yield* links(filename);
  }
}

// A packaged directory must survive both deletion of its source and relocation.
export async function validatePackagedDirectory(directory: string) {
  const root = await NodeFSP.realpath(directory);
  for await (const link of links(root)) {
    const target = await NodeFSP.readlink(link);
    if (
      NodePath.isAbsolute(target) ||
      !isInside(root, NodePath.resolve(NodePath.dirname(link), target))
    ) {
      throw new Error(`Packaged symlink is not relocatable: ${link} -> ${target}`);
    }
    const resolved = await NodeFSP.realpath(link).catch(() => undefined);
    if (!resolved || !isInside(root, resolved)) {
      throw new Error(`Packaged symlink is broken or leaves the bundle: ${link} -> ${target}`);
    }
  }
}

export async function copyRelocatableDirectory(source: string, destination: string) {
  const sourceRoot = await NodeFSP.realpath(source);
  await NodeFSP.cp(sourceRoot, destination, { recursive: true, verbatimSymlinks: true });
  // Some packaging steps already produce absolute links. Rebase only targets
  // inside this artifact; an external or missing target must fail the build.
  for await (const link of links(destination)) {
    const target = await NodeFSP.readlink(link);
    if (!NodePath.isAbsolute(target)) continue;
    const resolved = await NodeFSP.realpath(target);
    if (!isInside(sourceRoot, resolved)) {
      throw new Error(`Packaged symlink leaves the source: ${link} -> ${target}`);
    }
    const relocated = NodePath.resolve(destination, NodePath.relative(sourceRoot, resolved));
    await NodeFSP.unlink(link);
    await NodeFSP.symlink(
      NodePath.relative(NodePath.dirname(NodePath.resolve(link)), relocated),
      link,
    );
  }
  await validatePackagedDirectory(destination);
}
