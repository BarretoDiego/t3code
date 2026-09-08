# Capabilities and parameters

A capability is a provider-declared string id plus a category and operation
strings. Examples include `image.generate` with `generate`, or
`video.image-to-video` with `image-to-video`. Categories are strings so a new
modality does not require a T3 Code release.

Models can be declared under each capability. Their availability state,
operations, presets, parameter schema, and metadata are declarative. Parameter
ids such as `steps`, `fps`, or `guidance` have no special meaning to T3 Code.
Consumers render or validate only the schema announced by the provider.

Presets are parameter maps. Applying one is a client/provider concern; the core
records the selected preset and the request parameters without interpreting
their contents.
