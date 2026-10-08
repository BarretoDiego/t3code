import * as Option from "effect/Option";
import type { Command } from "effect/cli";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import type * as HelpDoc from "effect/cli/HelpDoc";
import * as Param from "effect/cli/Param";
import * as Primitive from "effect/cli/Primitive";

// These fields are present on Effect commands but are not part of its public
// Command type. Isolate the read-only adapter; the catalog tests guard upgrades.
const inspectCommand = (command: Command.Command.Any) =>
  command as Command.Command.Any & {
    readonly config: {
      readonly flags: ReadonlyArray<Param.AnyFlag>;
      readonly arguments: ReadonlyArray<Param.AnyArgument>;
    };
    readonly contextConfig: { readonly flags: ReadonlyArray<Param.AnyFlag> };
    readonly globalFlags: ReadonlyArray<{ readonly flag: Param.AnyFlag }>;
    readonly buildHelpDoc: (path: ReadonlyArray<string>) => HelpDoc.HelpDoc;
  };

// Effect exports these read-only helpers at runtime, but strips their internal
// declarations from the published types. Reuse them instead of reimplementing
// traversal of optional, transformed, alternative and variadic parameters.
const paramInternals = Param as typeof Param & {
  readonly extractSingleParams: (
    param: Param.Any,
  ) => ReadonlyArray<Param.Single<Param.ParamKind, unknown>>;
  readonly getParamMetadata: (param: Param.Any) => {
    readonly isOptional: boolean;
    readonly isVariadic: boolean;
    readonly variadicMin: Option.Option<number>;
    readonly variadicMax: Option.Option<number>;
  };
};
const primitiveInternals = Primitive as typeof Primitive & {
  readonly getChoiceKeys: (
    primitive: Primitive.Primitive<unknown>,
  ) => ReadonlyArray<string> | undefined;
};

const flagSpelling = (name: string) => (name.length === 1 ? `-${name}` : `--${name}`);

function describeParam(param: Param.Any) {
  const metadata = paramInternals.getParamMetadata(param);
  return paramInternals.extractSingleParams(param).map((single) => ({
    name: single.name,
    ...(single.kind === Param.flagKind
      ? { flag: flagSpelling(single.name), aliases: single.aliases.map(flagSpelling) }
      : {}),
    type: Primitive.getTypeName(single.primitiveType),
    metavar: single.typeName ?? null,
    description: Option.getOrNull(single.description),
    required:
      !metadata.isOptional &&
      !(single.kind === Param.flagKind && single.primitiveType._tag === "Boolean") &&
      (!metadata.isVariadic || Option.exists(metadata.variadicMin, (min) => min > 0)),
    variadic: metadata.isVariadic,
    minOccurrences: Option.getOrNull(metadata.variadicMin),
    maxOccurrences: Option.getOrNull(metadata.variadicMax),
    choices: primitiveInternals.getChoiceKeys(single.primitiveType) ?? null,
    hidden: single.hidden,
  }));
}

/**
 * Read the same parameter tree used by the parser, including hidden options.
 * Effect currently exposes command configs through its internal adapter only;
 * keep that dependency here and never parse options or run handlers to inspect them.
 */
export function buildCommandCatalog(root: Command.Command.Any) {
  const commands: Array<{
    path: ReadonlyArray<string>;
    name: string;
    alias: string | null;
    description: string | null;
    usage: string;
    unlisted: boolean;
    group: string | null;
    examples: Command.Command.Any["examples"];
    arguments: ReturnType<typeof describeParam>;
    flags: Array<
      ReturnType<typeof describeParam>[number] & {
        source: "command" | "inherited" | "global";
      }
    >;
    subcommands: ReadonlyArray<string>;
  }> = [];

  const visit = (
    command: Command.Command.Any,
    ancestors: ReadonlyArray<Command.Command.Any>,
    group: string | undefined,
  ): void => {
    const lineage = [...ancestors, command];
    const path = lineage.map((entry) => entry.name);
    const impl = inspectCommand(command);
    const flags = impl.config.flags.flatMap(describeParam).map((flag) => ({
      ...flag,
      source: "command" as const,
    }));
    const seen = new Set(flags.map((flag) => flag.name));
    const inherited = ancestors
      .flatMap((ancestor) => inspectCommand(ancestor).contextConfig.flags.flatMap(describeParam))
      .filter((flag) => {
        if (seen.has(flag.name)) return false;
        seen.add(flag.name);
        return true;
      })
      .map((flag) => ({ ...flag, source: "inherited" as const }));
    const globals = [
      ...new Set([
        ...GlobalFlag.BuiltIns,
        ...lineage.flatMap((entry) => inspectCommand(entry).globalFlags),
      ]),
    ]
      .flatMap((flag) => describeParam(flag.flag))
      .map((flag) => ({
        ...flag,
        required: false,
        source: "global" as const,
      }));
    const children = command.subcommands.flatMap((entry) => entry.commands);
    commands.push({
      path,
      name: command.name,
      alias: command.alias ?? null,
      description: command.description ?? null,
      usage: impl.buildHelpDoc(path).usage,
      unlisted: command.unlisted,
      group: group ?? null,
      examples: command.examples,
      arguments: impl.config.arguments.flatMap(describeParam),
      flags: [...flags, ...inherited, ...globals],
      subcommands: children.map((child) => child.name),
    });
    for (const entry of command.subcommands) {
      for (const child of entry.commands) visit(child, lineage, entry.group);
    }
  };
  visit(root, [], undefined);
  return commands;
}
