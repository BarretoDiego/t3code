# Marketplace

The Marketplace lets you discover and install reusable packages on any connected T3 Code
environment. The first supported package type is a provider template: a ready-made Codex, Claude,
Cursor, Grok, or OpenCode configuration that asks only for the values it needs, such as an API key
or model name.

## Install a provider template

1. Open **Settings → Marketplace**.
2. Choose the device where the provider should run. This can be the local environment or any
   connected remote environment.
3. Select a package and review its publisher, compatibility, and requested permissions.
4. Enter the requested values. Secret fields are sent directly to the selected environment and are
   stored with its other provider secrets.
5. Choose **Install provider**.

The new provider appears in **Settings → Providers**. Templates use isolated, T3-managed provider
directories when they need configuration files, so they do not overwrite an existing CLI setup.

Installed packages can be updated or uninstalled from their Marketplace details. Uninstalling a
provider template removes the provider instance and files owned by that package. It does not remove
the provider CLI itself.

Turn on **Auto-update** on an installed package to apply catalog updates automatically when you open
the Marketplace. Secrets are never re-asked: the update reuses the environment's stored values, and
you can turn it off at any time.

## Export your own configuration as a template

Any configured provider can become a shareable template. In **Settings → Providers**, open the
provider's configuration and choose **Export as template**. T3 Code generates the package manifest:
secret values become install-time password inputs and are never included, while non-secret values
(such as base URLs or model names) carry over as defaults. Review the JSON, then copy or download it
and add it to a marketplace repository to share it.

## Change a provider's icon

In the provider's configuration, use **Icon** to pick any AI brand icon — Claude, Kimi, DeepSeek,
GLM, MiniMax, Qwen, and many others — instead of the driver default. Marketplace templates may also
suggest an icon, which you can change afterwards.

## Add a community repository

Under **Marketplace repositories**, paste any of the following:

- a direct HTTP(S) URL to `t3-marketplace.json`;
- an HTTP(S) directory that contains `t3-marketplace.json`;
- a public GitHub repository URL; or
- a GitHub directory URL that includes `/tree/<branch>/...`.

Repositories belong to the selected environment. This keeps local, remote, and shared devices
independent. A repository cannot be removed while one of its packages is installed.

Treat a community repository like any other source of configuration. T3 Code validates its format,
compatibility, declared permissions, and optional integrity digest, but the repository publisher is
responsible for the package content. Provider templates are declarative: they cannot run install
scripts, and generated files are restricted to package-owned directories.

## Package types

The Marketplace format is not limited to providers. Catalogs may publish package types that a future
T3 Code version or extension knows how to install, including skills, MCP servers, tools, and other
resources. Older versions still show those packages and clearly mark them as unsupported instead of
silently dropping them.
