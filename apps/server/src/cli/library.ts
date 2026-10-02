// @effect-diagnostics nodeBuiltinImport:off -- the $EDITOR handoff needs a synchronous child process with inherited stdio and a temp file.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  AGENT_PROFILE_SLUG_PATTERN,
  AgentProfile,
  AgentProfileId,
  type AgentProfileRoute,
  isValidAgentProfileTemplate,
  type MiniSkill,
  MiniSkillId,
  type ModelSelection,
  ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
  slugifyAgentProfileName,
  type TurnAgentProfileContext,
  WS_METHODS,
} from "@t3tools/contracts";
import { mergeProfileMiniSkillIds, resolveAgentProfile } from "@t3tools/shared/agentProfiles";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { type EnvironmentRpcClient, environmentTargetFlags } from "./environmentRpc.ts";
import { jsonFlag, printJson, withClient } from "./common.ts";

export class LibraryCliError extends Schema.TaggedError<LibraryCliError>()("LibraryCliError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (detail: string): Effect.Effect<never, LibraryCliError> =>
  Effect.fail(new LibraryCliError({ detail }));
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const loadSettings = (client: EnvironmentRpcClient) => client[WS_METHODS.serverGetSettings]({});
const updateSettings = (client: EnvironmentRpcClient, patch: ServerSettingsPatch) =>
  client[WS_METHODS.serverUpdateSettings]({ patch });

// ---------------------------------------------------------------------------
// Lookup

/** Finds a library entry by exact id, unique id prefix, or exact name/slug (case-insensitive). */
function findEntry<T extends { readonly id: string; readonly name: string }>(
  entries: ReadonlyArray<T>,
  identifier: string,
  kind: string,
  extraKey?: (entry: T) => string,
): Effect.Effect<T, LibraryCliError> {
  const needle = identifier.trim();
  const lower = needle.toLowerCase();
  const exact = entries.find(
    (entry) =>
      entry.id === needle ||
      entry.name.toLowerCase() === lower ||
      (extraKey !== undefined && extraKey(entry).toLowerCase() === lower),
  );
  if (exact) return Effect.succeed(exact);
  const prefixed = entries.filter((entry) => entry.id.startsWith(needle));
  if (prefixed.length === 1) return Effect.succeed(prefixed[0]!);
  return fail(
    prefixed.length > 1
      ? `'${needle}' matches ${prefixed.length} ${kind}s; use the full id.`
      : `No ${kind} matches '${needle}'. Run \`t3 ${kind} list\`.`,
  );
}

export const findMiniSkill = (settings: ServerSettings, identifier: string) =>
  findEntry(settings.miniSkills, identifier, "skill");

export const findAgentProfile = (settings: ServerSettings, identifier: string) =>
  findEntry(settings.agentProfiles, identifier.replace(/^#/, ""), "profile", (entry) => entry.slug);

// ---------------------------------------------------------------------------
// Text input

/** Opens `$VISUAL`/`$EDITOR` on `initial` and returns the saved text. */
const editInEditor = (initial: string, suffix: string) =>
  Effect.try({
    try: () => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-edit-"));
      const file = NodePath.join(directory, `content${suffix}`);
      try {
        NodeFS.writeFileSync(file, initial);
        const editor = process.env.VISUAL || process.env.EDITOR || "vi";
        const result = NodeChildProcess.spawnSync(`${editor} "${file}"`, {
          stdio: "inherit",
          shell: true,
        });
        if (result.status !== 0) throw new Error(`${editor} exited with ${result.status}`);
        return NodeFS.readFileSync(file, "utf8");
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    },
    catch: (cause) => new LibraryCliError({ detail: "Editing was cancelled.", cause }),
  });

const readFileText = (path: string) =>
  Effect.try({
    try: () => NodeFS.readFileSync(path, "utf8"),
    catch: (cause) => new LibraryCliError({ detail: `Could not read ${path}.`, cause }),
  });

const readStdin = Effect.flatMap(Stdio.Stdio, (stdio) =>
  stdio.stdin.pipe(Stream.decodeText(), Stream.mkString),
);

/**
 * Markdown body from exactly one source: inline text (`-` = stdin), a file,
 * or the user's editor seeded with `current`. None given = unchanged.
 */
const readBody = Effect.fn("cli.library.readBody")(function* (
  sources: {
    readonly text: Option.Option<string>;
    readonly file: Option.Option<string>;
    readonly editor: boolean;
  },
  current: string,
) {
  const given = [Option.isSome(sources.text), Option.isSome(sources.file), sources.editor];
  if (given.filter(Boolean).length > 1) {
    return yield* fail("Pass only one of the inline text, the file, or --editor.");
  }
  if (Option.isSome(sources.text)) {
    return Option.some(sources.text.value === "-" ? yield* readStdin : sources.text.value);
  }
  if (Option.isSome(sources.file)) return Option.some(yield* readFileText(sources.file.value));
  if (sources.editor) return Option.some(yield* editInEditor(current, ".md"));
  return Option.none<string>();
});

const editorFlag = Flag.Boolean("editor").pipe(
  Flag.withDescription("Write the Markdown in $VISUAL/$EDITOR."),
  Flag.withDefault(false),
);
const booleanChoice = (name: string, description: string) =>
  Flag.Literals(name, ["true", "false"]).pipe(
    Flag.withDescription(description),
    Flag.map((value) => value === "true"),
    Flag.optional,
  );

// ---------------------------------------------------------------------------
// Mini skills

function skillSummary(skill: MiniSkill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    enabledByDefaultForNewThreads: skill.enabledByDefaultForNewThreads,
    updatedAt: skill.updatedAt,
  };
}

const skillContentFlags = {
  content: Flag.String("content").pipe(
    Flag.withDescription("Markdown instructions, or - to read them from stdin."),
    Flag.optional,
  ),
  file: Flag.String("file").pipe(
    Flag.withDescription("Read the Markdown instructions from this file."),
    Flag.optional,
  ),
  editor: editorFlag,
  description: Flag.String("description").pipe(
    Flag.withDescription("One-line summary shown in pickers."),
    Flag.optional,
  ),
  default: booleanChoice(
    "default",
    "Attach the skill to every new thread automatically (true/false).",
  ),
};

const skillListCommand = Command.make("list", { ...environmentTargetFlags, json: jsonFlag }).pipe(
  Command.withDescription("List mini skills."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.skill.list")(function* (client, flags) {
        const settings = yield* loadSettings(client);
        const skills = settings.miniSkills.map(skillSummary);
        if (flags.json) return yield* printJson(skills);
        if (skills.length === 0) return yield* Console.log("No mini skills.");
        yield* Console.log(
          skills
            .map(
              (skill) =>
                `${skill.id}  ${skill.name}${skill.enabledByDefaultForNewThreads ? "  [default]" : ""}${skill.description ? `\n    ${skill.description}` : ""}`,
            )
            .join("\n"),
        );
      }),
    ),
  ),
);

const skillShowCommand = Command.make("show", {
  ...environmentTargetFlags,
  skill: Argument.String("skill").pipe(Argument.withDescription("Skill id, id prefix, or name.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Print a mini skill, including its Markdown instructions."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.skill.show")(function* (client, flags) {
        const skill = yield* findMiniSkill(yield* loadSettings(client), flags.skill);
        if (flags.json) return yield* printJson(skill);
        yield* Console.log(
          [
            `${skill.name}  (${skill.id})${skill.enabledByDefaultForNewThreads ? "  [default for new threads]" : ""}`,
            skill.description,
            "",
            skill.content,
          ]
            .filter((line, index) => index !== 1 || line.length > 0)
            .join("\n"),
        );
      }),
    ),
  ),
);

const skillCreateCommand = Command.make("create", {
  ...environmentTargetFlags,
  name: Argument.String("name").pipe(Argument.withDescription("Skill name.")),
  ...skillContentFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a mini skill from --content, --file, stdin, or --editor."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.skill.create")(function* (client, flags) {
        const name = flags.name.trim();
        if (name.length === 0) return yield* fail("The skill name cannot be empty.");
        const content = yield* readBody(
          { text: flags.content, file: flags.file, editor: flags.editor },
          "",
        );
        if (Option.isNone(content) || content.value.trim().length === 0) {
          return yield* fail("Give the skill instructions with --content, --file, - or --editor.");
        }
        const settings = yield* loadSettings(client);
        const now = yield* nowIso;
        const skill: MiniSkill = {
          id: MiniSkillId.make(`skill-${NodeCrypto.randomUUID()}`),
          name,
          description: Option.getOrElse(flags.description, () => "").trim(),
          content: content.value,
          enabledByDefaultForNewThreads: Option.getOrElse(flags.default, () => false),
          createdAt: now,
          updatedAt: now,
        };
        yield* updateSettings(client, { miniSkills: [...settings.miniSkills, skill] });
        if (flags.json) return yield* printJson(skill);
        yield* Console.log(`Created ${skill.id} (${skill.name}).`);
      }),
    ),
  ),
);

const skillEditCommand = Command.make("edit", {
  ...environmentTargetFlags,
  skill: Argument.String("skill"),
  name: Flag.String("name").pipe(Flag.withDescription("New name."), Flag.optional),
  ...skillContentFlags,
}).pipe(
  Command.withDescription(
    "Change a mini skill. Only the given fields change; --editor opens the current text.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.skill.edit")(function* (client, flags) {
        const settings = yield* loadSettings(client);
        const skill = yield* findMiniSkill(settings, flags.skill);
        const content = yield* readBody(
          { text: flags.content, file: flags.file, editor: flags.editor },
          skill.content,
        );
        const name = Option.map(flags.name, (value) => value.trim());
        if (Option.isSome(name) && name.value.length === 0) {
          return yield* fail("The skill name cannot be empty.");
        }
        const next: MiniSkill = {
          ...skill,
          name: Option.getOrElse(name, () => skill.name),
          description: Option.getOrElse(flags.description, () => skill.description).trim(),
          content: Option.getOrElse(content, () => skill.content),
          enabledByDefaultForNewThreads: Option.getOrElse(
            flags.default,
            () => skill.enabledByDefaultForNewThreads,
          ),
          updatedAt: yield* nowIso,
        };
        yield* updateSettings(client, {
          miniSkills: settings.miniSkills.map((entry) => (entry.id === skill.id ? next : entry)),
        });
        yield* Console.log(`Updated ${skill.id} (${next.name}).`);
      }),
    ),
  ),
);

const skillDeleteCommand = Command.make("delete", {
  ...environmentTargetFlags,
  skill: Argument.String("skill"),
}).pipe(
  Command.withDescription(
    "Delete a mini skill. Threads keep the copy they were created with; profiles drop the reference.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.skill.delete")(function* (client, flags) {
        const settings = yield* loadSettings(client);
        const skill = yield* findMiniSkill(settings, flags.skill);
        yield* updateSettings(client, {
          miniSkills: settings.miniSkills.filter((entry) => entry.id !== skill.id),
        });
        yield* Console.log(`Deleted ${skill.id} (${skill.name}).`);
      }),
    ),
  ),
);

export const skillCommand = Command.make("skill").pipe(
  Command.withDescription("Read, create, edit, and delete mini skills."),
  Command.withSubcommands([
    skillListCommand,
    skillShowCommand,
    skillCreateCommand,
    skillEditCommand,
    skillDeleteCommand,
  ]),
);

// ---------------------------------------------------------------------------
// Agent profiles

function profileSummary(profile: AgentProfile) {
  return {
    id: profile.id,
    name: profile.name,
    slug: profile.slug,
    description: profile.description,
    enabled: profile.enabled,
    reasoningEffort: profile.reasoningEffort ?? null,
    miniSkillIds: profile.miniSkillIds,
    routes: profile.routes.map((route) => ({
      instanceId: route.instanceId,
      modelCandidates: route.modelCandidates,
      reasoningEffort: route.reasoningEffort ?? null,
    })),
    customTemplate: profile.promptTemplate !== undefined,
  };
}

function formatRoute(route: AgentProfileRoute): string {
  return `${route.instanceId}=${route.modelCandidates.join(",")}${route.reasoningEffort ? `@${route.reasoningEffort}` : ""}`;
}

/** Parses `<instance>=<model>[,<fallback>...][@<effort>]`. */
export function parseRoute(value: string, id: string): AgentProfileRoute | null {
  const match = /^([^=\s]+)=([^@]*)(?:@(\S+))?$/.exec(value.trim());
  if (!match) return null;
  const modelCandidates = match[2]!
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
  return {
    id,
    instanceId: ProviderInstanceId.make(match[1]!),
    modelCandidates,
    ...(match[3] ? { reasoningEffort: match[3] } : {}),
  };
}

const decodeProfile = Schema.decodeUnknownEffect(AgentProfile);

const profileFields = {
  slug: Flag.String("slug").pipe(
    Flag.withDescription("Short handle used as #slug in the composer and --profile here."),
    Flag.optional,
  ),
  description: Flag.String("description").pipe(
    Flag.withDescription("One-line summary shown in pickers."),
    Flag.optional,
  ),
  enabled: booleanChoice("enabled", "Whether the profile can be selected (true/false)."),
  reasoningEffort: Flag.String("reasoning-effort").pipe(
    Flag.withDescription("Base reasoning effort, e.g. low, medium, high. Pass '' to inherit."),
    Flag.optional,
  ),
  skills: Flag.String("skills").pipe(
    Flag.withDescription("Comma-separated mini skill ids or names applied with the profile."),
    Flag.optional,
  ),
  instructions: Flag.String("instructions").pipe(
    Flag.withDescription("Profile instructions (Markdown), or - to read them from stdin."),
    Flag.optional,
  ),
  instructionsFile: Flag.String("instructions-file").pipe(
    Flag.withDescription("Read the profile instructions from this file."),
    Flag.optional,
  ),
  editor: editorFlag,
  templateFile: Flag.String("template-file").pipe(
    Flag.withDescription(
      "Custom prompt template; must contain {{user_message}}. Pass '' to use the default.",
    ),
    Flag.optional,
  ),
  route: Flag.String("route").pipe(
    Flag.withDescription(
      "Model route <instance>=<model>[,<fallback>...][@<effort>]; repeat per provider instance. Replaces existing routes.",
    ),
    Flag.atLeast(0),
  ),
};

type ProfileFieldFlags = {
  readonly [K in keyof typeof profileFields]: (typeof profileFields)[K] extends Flag.Flag<infer A>
    ? A
    : never;
};

/** Applies the given flags to `base`, validating the result like the settings editor does. */
const buildProfile = Effect.fn("cli.profile.build")(function* (
  settings: ServerSettings,
  base: AgentProfile,
  flags: ProfileFieldFlags,
) {
  const instructions = yield* readBody(
    { text: flags.instructions, file: flags.instructionsFile, editor: flags.editor },
    base.instructions,
  );
  const skillIds = Option.isSome(flags.skills)
    ? yield* Effect.forEach(
        flags.skills.value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
        (identifier) => findMiniSkill(settings, identifier).pipe(Effect.map((skill) => skill.id)),
      )
    : base.miniSkillIds;
  let routes = base.routes;
  if (flags.route.length > 0) {
    const parsed: AgentProfileRoute[] = [];
    for (const value of flags.route) {
      const route = parseRoute(value, `route-${NodeCrypto.randomUUID()}`);
      if (route === null) {
        return yield* fail(
          `Invalid --route '${value}'. Use <instance>=<model>[,<model>][@<effort>].`,
        );
      }
      parsed.push(route);
    }
    routes = parsed;
  }
  let promptTemplate = base.promptTemplate;
  if (Option.isSome(flags.templateFile)) {
    if (flags.templateFile.value === "") {
      promptTemplate = undefined;
    } else {
      promptTemplate = yield* readFileText(flags.templateFile.value);
      if (!isValidAgentProfileTemplate(promptTemplate)) {
        return yield* fail("The template must contain {{user_message}}.");
      }
    }
  }
  const reasoningEffort = Option.isSome(flags.reasoningEffort)
    ? flags.reasoningEffort.value.trim()
    : (base.reasoningEffort ?? "");
  const slug = Option.getOrElse(flags.slug, () => base.slug).trim();
  if (!new RegExp(AGENT_PROFILE_SLUG_PATTERN).test(slug)) {
    return yield* fail(
      `Invalid slug '${slug}'. Use lowercase letters, digits, and hyphens, starting with a letter.`,
    );
  }
  if (settings.agentProfiles.some((entry) => entry.slug === slug && entry.id !== base.id)) {
    return yield* fail(`Another profile already uses the slug '${slug}'.`);
  }
  const { promptTemplate: _template, reasoningEffort: _effort, ...rest } = base;
  return yield* decodeProfile({
    ...rest,
    slug,
    description: Option.getOrElse(flags.description, () => base.description).trim(),
    enabled: Option.getOrElse(flags.enabled, () => base.enabled),
    miniSkillIds: skillIds,
    instructions: Option.getOrElse(instructions, () => base.instructions),
    routes,
    ...(reasoningEffort.length > 0 ? { reasoningEffort } : {}),
    ...(promptTemplate !== undefined ? { promptTemplate } : {}),
    updatedAt: yield* nowIso,
  }).pipe(
    Effect.mapError(
      (cause) => new LibraryCliError({ detail: `Invalid profile: ${cause.message}`, cause }),
    ),
  );
});

const profileListCommand = Command.make("list", {
  ...environmentTargetFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List agent profiles."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.profile.list")(function* (client, flags) {
        const settings = yield* loadSettings(client);
        const profiles = settings.agentProfiles.map(profileSummary);
        if (flags.json) return yield* printJson(profiles);
        if (profiles.length === 0) return yield* Console.log("No agent profiles.");
        yield* Console.log(
          profiles
            .map(
              (profile) =>
                `#${profile.slug}  ${profile.name}${profile.enabled ? "" : "  [disabled]"}  (${profile.id})${profile.description ? `\n    ${profile.description}` : ""}`,
            )
            .join("\n"),
        );
      }),
    ),
  ),
);

const profileShowCommand = Command.make("show", {
  ...environmentTargetFlags,
  profile: Argument.String("profile").pipe(Argument.withDescription("Profile slug, id, or name.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Print an agent profile in full."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.profile.show")(function* (client, flags) {
        const settings = yield* loadSettings(client);
        const profile = yield* findAgentProfile(settings, flags.profile);
        if (flags.json) return yield* printJson(profile);
        const skillNames = profile.miniSkillIds.map(
          (id) => settings.miniSkills.find((skill) => skill.id === id)?.name ?? `${id} (missing)`,
        );
        yield* Console.log(
          [
            `#${profile.slug}  ${profile.name}  (${profile.id})${profile.enabled ? "" : "  [disabled]"}`,
            profile.description ? profile.description : null,
            `Reasoning effort: ${profile.reasoningEffort ?? "inherit"}`,
            `Mini skills: ${skillNames.length > 0 ? skillNames.join(", ") : "none"}`,
            `Routes: ${profile.routes.length > 0 ? profile.routes.map(formatRoute).join("  ") : "none (keeps the current model)"}`,
            `Template: ${profile.promptTemplate !== undefined ? "custom" : "default"}`,
            "",
            profile.instructions || "(no instructions)",
            ...(profile.promptTemplate !== undefined
              ? ["", "── template", profile.promptTemplate]
              : []),
          ]
            .filter((line) => line !== null)
            .join("\n"),
        );
      }),
    ),
  ),
);

const profileCreateCommand = Command.make("create", {
  ...environmentTargetFlags,
  name: Argument.String("name").pipe(
    Argument.withDescription("Profile name; the slug is derived from it unless --slug is given."),
  ),
  ...profileFields,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create an agent profile."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.profile.create")(function* (client, flags) {
        const name = flags.name.trim();
        if (name.length === 0) return yield* fail("The profile name cannot be empty.");
        const settings = yield* loadSettings(client);
        const now = yield* nowIso;
        const base = {
          id: AgentProfileId.make(`profile-${NodeCrypto.randomUUID()}`),
          name,
          slug: slugifyAgentProfileName(name) as AgentProfile["slug"],
          description: "",
          enabled: true,
          miniSkillIds: [],
          instructions: "",
          routes: [],
          createdAt: now,
          updatedAt: now,
        } satisfies AgentProfile;
        const profile = yield* buildProfile(settings, base, flags);
        yield* updateSettings(client, { agentProfiles: [...settings.agentProfiles, profile] });
        if (flags.json) return yield* printJson(profile);
        yield* Console.log(`Created #${profile.slug} (${profile.id}).`);
      }),
    ),
  ),
);

const profileEditCommand = Command.make("edit", {
  ...environmentTargetFlags,
  profile: Argument.String("profile"),
  name: Flag.String("name").pipe(Flag.withDescription("New name."), Flag.optional),
  ...profileFields,
}).pipe(
  Command.withDescription(
    "Change an agent profile. Only the given fields change; --editor opens the current instructions.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.profile.edit")(function* (client, flags) {
        const settings = yield* loadSettings(client);
        const existing = yield* findAgentProfile(settings, flags.profile);
        const name = Option.getOrElse(flags.name, () => existing.name).trim();
        if (name.length === 0) return yield* fail("The profile name cannot be empty.");
        const profile = yield* buildProfile(settings, { ...existing, name }, flags);
        yield* updateSettings(client, {
          agentProfiles: settings.agentProfiles.map((entry) =>
            entry.id === existing.id ? profile : entry,
          ),
        });
        yield* Console.log(`Updated #${profile.slug} (${profile.id}).`);
      }),
    ),
  ),
);

const profileDeleteCommand = Command.make("delete", {
  ...environmentTargetFlags,
  profile: Argument.String("profile"),
}).pipe(
  Command.withDescription("Delete an agent profile. Turns already sent keep what they resolved."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.profile.delete")(function* (client, flags) {
        const settings = yield* loadSettings(client);
        const profile = yield* findAgentProfile(settings, flags.profile);
        yield* updateSettings(client, {
          agentProfiles: settings.agentProfiles.filter((entry) => entry.id !== profile.id),
        });
        yield* Console.log(`Deleted #${profile.slug} (${profile.id}).`);
      }),
    ),
  ),
);

export const profileCommand = Command.make("profile").pipe(
  Command.withDescription("Read, create, edit, and delete agent profiles."),
  Command.withSubcommands([
    profileListCommand,
    profileShowCommand,
    profileCreateCommand,
    profileEditCommand,
    profileDeleteCommand,
  ]),
);

// ---------------------------------------------------------------------------
// Using skills and profiles in a turn

/** What `thread new`/`send` add to a turn for `--skill` and `--profile`. */
export interface TurnLibraryExtras {
  readonly modelSelection: ModelSelection;
  readonly miniSkillIds: ReadonlyArray<MiniSkillId>;
  readonly agentProfile: TurnAgentProfileContext | null;
}

/**
 * Resolves `--skill`/`--profile` the way the composer does: the profile adapts
 * to the thread's provider instance (route model + effort), and its skills are
 * merged ahead of the manually picked ones.
 */
export const resolveTurnLibrary = Effect.fn("cli.library.resolveTurn")(function* (
  client: EnvironmentRpcClient,
  input: {
    readonly modelSelection: ModelSelection;
    readonly skills: ReadonlyArray<string>;
    readonly profile: Option.Option<string>;
  },
) {
  if (input.skills.length === 0 && Option.isNone(input.profile)) {
    return {
      modelSelection: input.modelSelection,
      miniSkillIds: [],
      agentProfile: null,
    } satisfies TurnLibraryExtras;
  }
  const settings = yield* loadSettings(client);
  const manual = yield* Effect.forEach(input.skills, (identifier) =>
    findMiniSkill(settings, identifier).pipe(Effect.map((skill) => skill.id)),
  );
  if (Option.isNone(input.profile)) {
    return {
      modelSelection: input.modelSelection,
      miniSkillIds: manual,
      agentProfile: null,
    } satisfies TurnLibraryExtras;
  }
  const profile = yield* findAgentProfile(settings, input.profile.value);
  if (!profile.enabled) {
    return yield* fail(
      `Profile #${profile.slug} is disabled. Enable it with \`t3 profile edit ${profile.slug} --enabled true\`.`,
    );
  }
  const config = yield* client[WS_METHODS.serverGetConfig]({});
  const provider = config.providers.find(
    (entry) => entry.instanceId === input.modelSelection.instanceId,
  );
  const currentEffort = input.modelSelection.options?.find(
    (option) => option.id === "reasoningEffort",
  )?.value;
  const resolution = resolveAgentProfile({
    profile,
    instanceId: input.modelSelection.instanceId,
    availableModelSlugs: provider?.models.map((model) => model.slug) ?? [],
    currentModelSelection: input.modelSelection,
    currentReasoningEffort: typeof currentEffort === "string" ? currentEffort : null,
    getSupportedReasoningEfforts: (slug) => {
      const option = provider?.models
        .find((model) => model.slug === slug)
        ?.capabilities?.optionDescriptors?.find((entry) => entry.id === "reasoningEffort");
      return option?.type === "select" ? option.options.map((item) => item.id) : null;
    },
    defaultWrapper: settings.agentProfileDefaultWrapper,
    knownMiniSkillIds: settings.miniSkills.map((skill) => skill.id),
  });
  if (resolution.status === "unavailable") {
    return yield* fail(`Profile #${profile.slug} cannot run here: ${resolution.reason}`);
  }
  return {
    modelSelection: resolution.modelSelection,
    miniSkillIds: mergeProfileMiniSkillIds(resolution.miniSkillIds, manual),
    agentProfile: {
      profileId: resolution.profileId,
      profileName: resolution.profileName,
      instructions: resolution.instructions,
      promptTemplate: resolution.promptTemplate,
      ...(resolution.diagnostics.fallbackIndex !== null
        ? { fallbackIndex: resolution.diagnostics.fallbackIndex }
        : {}),
    },
  } satisfies TurnLibraryExtras;
});
