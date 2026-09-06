# Agent Profiles

Agent Profiles are reusable execution presets for the composer. A profile bundles a reasoning
effort, Mini Skills, profile instructions, and provider-specific model routing into one named
preset you can apply to any thread. Manage the library in **Settings → Agent Profiles**.

The default profile is **Custom** — the existing manual behavior, unchanged.

## Selecting a profile

Pick a profile from the **profile selector** in the composer footer, or type `#shortcut` at the
start of a message (for example `#reviewer`) and accept the autocomplete entry. The token becomes
composer state and never appears in the sent text. A selection is per thread and stays active
across messages until you switch back to **Custom** or to another profile.

While a profile is active, the model and reasoning controls show the resolved values and stay
read-only. Your manual Custom configuration is preserved and returns when you switch back. If the
profile cannot run on the current provider — for example, none of its model candidates is
available — sending is blocked with an explanation until you switch provider or return to Custom.

## How a profile resolves

A profile adapts to the thread's current provider; it never switches providers for you.

- **Model**: the first available candidate from the matching provider configuration. If the
  provider has no configuration (or it lists no candidates), the profile keeps the provider's
  current model. A configuration whose candidates are all unavailable blocks sending rather than
  picking an arbitrary model.
- **Reasoning effort**: provider configuration override → profile base → the composer's current
  selection. An effort the resolved model does not support is skipped.
- **Mini Skills**: the profile's skills merge with any skills you select manually for the request,
  deduplicated. Profile skills stay selected with the profile; manual picks still clear after a
  successful send.
- **Instructions and template**: the profile's own Markdown instructions render through its prompt
  template — its custom one, or the **Default profile wrapper** from Settings. `{{user_message}}`
  is required so your request text always reaches the agent; `{{profile_instructions}}`,
  `{{mini_skills}}`, and `{{profile_name}}` are optional slots.

## Editing profiles

The editor covers the name, the `#shortcut` (unique, lowercase letters/numbers/hyphens, starting
with a letter), a description, and an enabled toggle. **Base configuration** holds the shared
reasoning effort, Mini Skills, and instructions. **Provider configurations** route the profile to
ordered model candidates per provider — primary first, then fallbacks — with an optional reasoning
override; fields left empty inherit the base. Profiles can be duplicated to start from an existing
configuration.

Profiles are global: they are available in every project and sync across your connected
environments. Editing a profile affects future sends only; turns already sent keep the
configuration they ran with.
