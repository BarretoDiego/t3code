# Source control

T3 Code integrates with GitHub, GitLab, Bitbucket, and Azure DevOps to clone and publish
repositories, create pull requests, and review changes.

## Connect an account

Install Git and configure authentication on the machine running your T3 Code server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source Control**
and choose **Rescan**.

### GitHub

Install [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, then sign in:

```bash
gh auth login
```

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

### Bitbucket

Set an access token in the server's environment:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
```

Or use an Atlassian account email and API token with read/write access to repositories and pull
requests, plus user read access (`read:user:bitbucket`):

```bash
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

The access token takes precedence if both are configured. Restart the server after changing these
variables.

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

## Clone or publish a project

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. T3 Code can generate commit
messages, review titles, and descriptions from your changes.

Choose the writing style and model in **Settings → Source Control**. **Repository conventions**
uses the project's instructions and recent commit subjects.

## Review and merge

Open **Pull requests** to review changes and comments, request reviewers, check out a branch,
or merge. You can edit review titles and descriptions and your own comments where the host allows it.
GitLab calls these merge requests.

GitHub, GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also
supports approving waiting fork workflows and opening a revert pull request for a merged change.

For Azure DevOps, use the host website to view diffs or change comments. Bitbucket does not support
reopening a declined pull request.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  confirm the running server received the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

## Source Control Hub and AI review

Open **Source control** in the sidebar. **Changes** shows the selected local project's files and diffs.
Select files, write or generate a commit message, then confirm the commit. Selected files are staged
at commit time; committing does not push. **Pull requests** opens your PR inbox, and **Repositories**
lets you browse GitHub or Bitbucket without cloning. Use **Connect account**, also available in
**Settings → Source Control**, to verify an API token before saving or reuse environment credentials.
Tokens belong to the selected environment. GitHub requires GitHub CLI; Bitbucket can use an access
token or an email and API token. A Bitbucket workspace narrows repository browsing. API authentication does not configure SSH keys
or Git credential helpers for fetch and push.

The repository's **Worktrees** view shows associated projects across connected environments,
including each checkout's branch and HEAD. Associate a project manually if its remote URL cannot
be identified, or restore automatic association later. Local Git actions operate on the selected clone.
Remote comments, reviews, and merges operate on the selected pull request.

In a pull request, open **Review**, choose an Agent Profile or a custom harness and model, and run
a review. Mini Skills apply to that review request. Quick samples patches; Standard analyzes changed
files in bounded batches and reads nearby code. Deep adds an isolated checkout at the PR head;
Exhaustive adds another architecture, security, and test-coverage pass. Deep and Exhaustive require
an associated local project when reviewing code. Metadata and commit-message scopes do not require
a checkout. Important findings are rechecked before the draft is prepared.

During execution, **Review agents** shows public draft text and the tasks and tools reported by the
harness. Preliminary text is not a validated finding.

Review results stay local until you select findings, edit or dismiss them, and confirm publication.
Merge is a separate manual action. If the PR changes, run another review before publishing.
Incremental reviews compare against the last completed review's head; after rewritten GitHub history,
run a full review. If publication loses its connection, inspect PR activity before preparing a new
review: the previous draft will not retry an uncertain publication. Coverage warnings identify sampled, generated, unavailable, or bounded context.

The Hub and an AI Review panel can share a split workspace with agent threads and be saved in a
workspace layout. The existing Pull requests and thread Git workflows remain available.

For commit messages, choose **Generate message with agent** in the commit dialog. The preview uses
your writing style, Agent Profile, and selected Mini Skills, without changing staging or committing.
Review and edit the generated text before committing.

### Bitbucket credentials

Use an Atlassian email with an API token, or choose an integration access token in the connection wizard. Integration tokens require a workspace; repository-scoped tokens require the repository slug too. Verification reads repository access without requiring access to the user profile. The desktop app imports `T3CODE_BITBUCKET_EMAIL`, `T3CODE_BITBUCKET_API_TOKEN`, `T3CODE_BITBUCKET_ACCESS_TOKEN` and `T3CODE_BITBUCKET_WORKSPACE` from its login shell on startup. Restart the desktop app after changing these variables. Saved account credentials take precedence over environment credentials.

### Reviewer instructions

Customize the default analysis prompt in **Settings → Source Control → AI review → Reviewer instructions**. The same section sets the language used for summaries, walkthroughs and findings, and a default reasoning effort, which applies only when the run's model supports it and no per-run choice was made. New runs use these preferences alongside the selected Agent Profile and Mini Skills. The agent determines the number of actionable findings; publication remains a separate, confirmed action. Findings marked **AI analysis · Draft finding** are local suggestions. Open a finding's file to inspect its explanation alongside the diff, then return to the draft to edit, dismiss or publish it.

### Repositories on your devices

Open **Source Control → Repositories → On your devices** to find folders and repositories already associated with T3 projects, grouped by environment. Search by project name or path. Select a checkout to inspect its branch and worktrees, open the project, or switch to its Changes view.

Use **Add existing** for a folder already downloaded on an environment. **Clone repository** opens the existing Git URL workflow: choose the destination environment and confirm the local folder, then T3 clones the repository and opens it as a project. Git uses that environment's existing credentials. Remote repository pages can prefill the clone URL. The catalog does not scan your disk for unregistered folders.

## Linked pull requests

A thread can hold several pull requests, including reviews from another repository on the same host.
Use **Link pull request** in the command palette or **Linked pull requests** panel, or right-click a
pull request link in the conversation. Creating a pull request from Git actions links it automatically.
Agents can link their pull requests with the `link_pull_request` tool.

Use **Link this PR** in a branch-detected badge's tooltip to keep it with the thread. From a review
on the Pull Requests page, **Link to thread** lets you search for an active thread. The review header
also lists the threads that link to it, including archived threads, so you can return to their context.

Thread badges show a stack's layer count or the current review number with a count of additional
links. On mobile, the Git overview lists linked reviews and their stacks; tap a review to open it.
Linking and unlinking are available in the web and desktop clients.

The **Linked pull requests** panel lists every review and groups stacks. Unlink a review from its
row menu. An unlinked stack layer stays out of later syncs. Open linked reviews refresh on the server;
closed reviews refresh periodically so reopening one on the host is detected. Merged reviews refresh
when requested. With **Auto-settle merged threads** enabled, a thread can settle after every linked
review is terminal. An open or unsynced link keeps it active.

Cross-repository links use a project on the same host. Azure DevOps reviews require a project checked
out from the matching organization and repository.

## GitHub stacks

The Pull Requests page shows each PR's position in its GitHub stack. Open the stack badge in a
review to navigate its layers. **Merge stack** submits the selected pull request and every unmerged
layer below it to GitHub together, respecting branch rules and merge queues. The confirmation shows
the scope and merge strategy. GitHub rebases the remaining stack after merging.

**Rebase stack** updates remote branches from bottom to top without changing your local checkout.
It can rewrite history and restart checks. If a layer fails, earlier updates remain; resolve that
layer before retrying. GitHub may require manual conflict resolution after a lower layer is amended,
even when its changes look independent. Stack actions require an environment that supports them.
