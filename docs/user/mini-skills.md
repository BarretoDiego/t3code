# Mini Skills

Mini Skills are reusable Markdown instructions you can attach to agent requests instead of
retyping them. Manage the library in **Settings → Mini Skills**.

A Mini Skill has a name, an optional description, and Markdown content. It is plain instruction
text for the agent — it never runs code, calls tools, or changes what the agent is allowed to do.

## Request skills

Select one or more skills from the **Mini Skills** control in the composer footer to attach them
to the next message only. The chat keeps showing the message you typed; the selected instructions
are added to what the agent receives. A successful send clears the selection, and a failed send
keeps it so you can retry.

## Thread skills

Mark a skill as **Enable by default for new threads** to attach it automatically to every new
thread. Each thread stores a snapshot of the skill as of its creation, so editing or deleting the
skill later never changes existing threads. Threads created before the change keep working with
their original instructions.

## Prompt wrappers

**Settings → Mini Skills → Prompt Wrappers** edits the text that surrounds selected skills when
they are sent to the agent, separately for thread and request scopes. The `{{skills}}` token marks
where the skills are inserted and must stay in the wrapper. **Reset to default** restores the
built-in wrapper.

The library syncs across your connected environments with your other shared preferences.
