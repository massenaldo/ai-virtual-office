# Running the Claude runtime as a dedicated operating-system user

**Decision (3B.5 prerequisite 3):** before the Claude agent is allowed to write on a workspace that matters, the server runs as a **dedicated, unprivileged user** that owns nothing but this project's data and the workspaces the agent may use. The server now enforces the minimum: it refuses to start `RUNTIME=claude` as root and when a workspace contains the application's own folder, and it warns when the data folder is readable by others or the server user's home holds credentials.

## Why

The agent's tools are policy-checked (workspace folders, a sensitive-path denylist, a person approving each change), but the Claude Code child process and the server run as one operating-system user. Everything that user can read or write is one flaw away from the agent: a bug in a path check, in the SDK's binary, or a change a person approves without reading. On a developer's own account that means SSH keys, cloud credentials, other projects, shell startup files. A dedicated user shrinks that to the project.

On the machine this was written on, the server user has `~/.ssh` in its home and the server said so when started: that is the case this document is for.

## What a dedicated user does and does not do

| It does | It does not |
|---|---|
| Keep your SSH keys, cloud credentials, other repositories and shell files out of reach of a flaw | Stop network access: the child can still reach the internet |
| Make the damage of an approved bad write end at the workspace | Isolate the kernel or other processes of the same user (it is not a sandbox, container or VM) |
| Keep the data folder (API token, audit log, state) readable only by that user | Stop a person who approves a harmful change from causing harm inside the workspace |

## Setup on Debian (as root or with sudo)

```bash
# 1. The user and its home (no login shell needed for the service itself; use sudo -u to start it)
adduser --system --group --home /srv/vo --shell /bin/bash voagent

# 2. The project, owned by that user, writable by nobody else
git clone <your repository> /srv/vo/app            # or copy it
chown -R voagent:voagent /srv/vo/app
cd /srv/vo/app && sudo -u voagent -H npm ci

# 3. The data folder: private
install -d -m 700 -o voagent -g voagent /srv/vo/data

# 4. The workspaces the agent may use: separate from the project, owned by the user
install -d -m 755 -o voagent -g voagent /srv/vo/workspaces/sandbox

# 5. Configuration, in a file only the user can read
sudo -u voagent -H tee /srv/vo/app/.env >/dev/null <<'ENV'
DATA_DIR=/srv/vo/data
WORKSPACE_ROOT=/srv/vo/workspaces
WORKSPACES=sandbox:sandbox
ENV
chmod 600 /srv/vo/app/.env
# add RUNTIME=claude and ANTHROPIC_API_KEY=... to that file only when you are ready (see docs/first-real-run.md)

# 6. Start it as that user, in tmux
sudo -u voagent -H tmux new -s vo
cd /srv/vo/app && npm run server        # or npm run start:public (see the README)
```

Keep the workspace folder **outside** `/srv/vo/app`: the server refuses a workspace that contains the application folder, because the agent could then change the server's code or `.env`. Do not give the user `sudo`, and do not add it to the `docker` group.

## Checks to run once

```bash
sudo -u voagent -H bash -c 'id; ls -la ~; stat -c "%a %U" /srv/vo/data; test ! -e ~/.ssh && echo "no ssh keys"'
# expected: uid is not 0; no credential folders; data folder is 700 voagent
```

If you see root, a credential folder or a data folder that is not 700, fix that before enabling writes.

## Escape hatch

`VO_ALLOW_ROOT=yes` lets the claude runtime start as root. It exists for throwaway containers; do not use it on a machine you care about.

## A next step if you need more

Wrap the child process in an operating-system sandbox (for example Anthropic's `@anthropic-ai/sandbox-runtime`, which uses bubblewrap on Linux) through the SDK's `spawnClaudeCodeProcess`. That needs our own process spawn, so it is a separate change with a reviewed exception to `server/noProcessExecution.test.ts`. It was not done in 3B.5.
