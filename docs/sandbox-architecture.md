**Design only. Not implemented. No sandbox isolation is active.**

# Sandbox architecture for the real agent runtime

**Status:** proposal for milestone 3B.2 and later, written 2026-10-31. Nothing here exists in the code. The backend runs the mock runtime only, the Claude Agent SDK is not installed, and the workspace and tool checks in `server/` are policy checks on the host, not isolation. Docker is not installed on the machine this was written on, so none of the commands below have been run.

## Why a sandbox

The tool gate (`server/toolGate.ts`) decides whether an action may run and re-checks it just before it runs. It cannot stop a permitted action from doing more than it should: an approved `Bash` command runs with every right of the server's user, and a check at time T does not bind the file system at time T+1. The sandbox is the second layer: even an approved action can only touch one workspace, cannot reach the network, and is limited in CPU, memory, processes, output and time.

## What it is

One container per task, started by the server, in which every tool action runs. The Claude session itself stays on the host (see "The network problem").

| Requirement (plan.md Phase 2) | Design |
|---|---|
| Non-root container | `--user 10001:10001`; the image has no `sudo`, no setuid binaries. `--cap-drop ALL`, `--security-opt no-new-privileges` |
| Only the selected workspace mounted | One bind mount: the workspace's real path (from `resolveWorkspace`, never from the browser or the model) to `/workspace`, read-write, as the working directory. Nothing else from the host, and no `--volume` for `DATA_DIR`, the audit log or the token file |
| No other host file system access | No `--privileged`, no `--device`, no host PID, IPC or network namespaces, no `--mount` of anything but the workspace |
| Read-only root file system where practical | `--read-only`, plus `--tmpfs /tmp:rw,noexec,nosuid,size=64m` and `--tmpfs /home/agent:rw,noexec,nosuid,size=16m` for tools that need a home. Not practical: tools that must write outside `/workspace` and `/tmp` (package managers); those stay unsupported until 3B.3 |
| No Docker socket | The socket is never mounted into the container, and the image contains no Docker client |
| Network disabled by default | `--network none`. A task can only get a network through an explicit, audited, per-task opt-in that does not exist yet |
| CPU, memory, processes | `--cpus 1`, `--memory 1g --memory-swap 1g` (no swap), `--pids-limit 128`, `--ulimit nofile=1024`, `--ulimit fsize` for file size. Values go in config (`SANDBOX_CPUS`, `SANDBOX_MEMORY`, `SANDBOX_PIDS`), not code |
| Output size | The server reads the container's stdout and stderr itself and counts bytes. It stops reading and kills the container at `MAX_TASK_OUTPUT_BYTES` (the same cap the manager already applies to events). The container's own log driver is `none`, so no log file grows on the host |
| Execution time | The manager's task timer already ends a task at `TASK_TIMEOUT_MS`. Each tool call also gets its own wall-clock limit inside the container (`timeout`), shorter than the task limit, and the container has `--stop-timeout 2` |
| Safe termination and cleanup | `docker stop -t 2` on cancel, timeout, task end and server shutdown, then `docker kill`, then `--rm`. The container is named `vo-<taskId>` and labelled `vo.owner=ai-virtual-office` and `vo.task=<id>`. At server start a sweep lists containers with that label and removes them, so a crash never leaves one running |
| Explicit environment allowlist | The container starts with an empty environment plus a fixed list (`PATH`, `HOME=/home/agent`, `LANG`, `TERM=dumb`). Nothing is inherited from the server's environment, and `-e` is never built from a template or from model input |
| No stored credentials | `ANTHROPIC_API_KEY`, `API_TOKEN` and the audit and data files never enter the container, its image, or any layer. The image is built without build arguments carrying secrets and is rebuilt from a pinned base, not pulled from a latest tag |

Image: a small pinned base (for example a digest-pinned Debian slim) with only the tools the catalogue needs (`bash`, `coreutils`, `grep`, `findutils`, `git`). No compiler or package manager in the first version.

## Where it sits relative to the tool gate

```
Claude session (host)
  -> canUseTool / in-process SDK MCP tool
    -> ctx.tools.use(request, perform)        policy + human approval + use-time check (exists, 3B.1.1)
      -> perform(action)                      action = frozen input + checked workspace
        -> sandbox.run(action)                 NEW: runs the action inside the container, nothing on the host
```

- The gate stays the only way to use a tool. The sandbox is what `perform` calls; it is never reachable except through `perform`.
- Reads are also served from the container, so a path that is a symlink out of the workspace resolves inside the container (to a harmless place) and not on the host.
- `perform` receives the workspace's real path only to build the one bind mount. The container sees `/workspace`, so no host path appears in tool output (this complements the path hiding in the manager).
- The sandbox adds a third check to the existing two: the host-side path check at approval, the re-check just before `perform`, and the container boundary at execution. A race between the last two can then at worst touch the workspace.

## The network problem (the hard part)

The model API call needs the network; the tools must not have it. A container with `--network none` cannot run the Claude Agent SDK, because the SDK's own loop calls the API.

| Option | How | Cost |
|---|---|---|
| **A. Session on the host, tools in the container (recommended)** | The SDK runs in the server process. Its built-in file and shell tools are disabled. In-process SDK MCP tools (`Read`, `Glob`, `Grep`, `Write`, `Edit`, `Bash`) each call `ctx.tools.use(..., perform)`, and `perform` runs the action in the container (`docker exec` equivalent). | The API key stays on the host and the container has no network at all. The SDK's built-in tools must be turned off, which also closes the gap noted in `claudeAgent.ts` (built-in tools run after `canUseTool` returns). More code: our own tool implementations |
| B. Whole session in the container with egress only to the API | The container gets a network whose only route is a proxy that allows `api.anthropic.com`. | The key must reach the process inside the container (a credential in the container's memory and environment). Tool code could use the same route. The proxy and its allowlist are another security component |
| C. Session in the container, key via the proxy | The proxy injects the key, the container never sees it. | Needs a custom proxy; still shares the network namespace with tools |

Recommendation: **A.** It keeps `--network none` honest and the key out of the container. Option B or C only if the SDK cannot run in-process.

## Technical blockers

1. **Docker access for the server.** Starting containers needs the Docker Engine, either the CLI (a child process, which `server/noProcessExecution.test.ts` forbids) or its HTTP API over the unix socket (`node:http` with `socketPath`, no child process). The second fits the guard but gives the server process root-equivalent power over the host through the socket. Mitigations to evaluate: rootless Docker or Podman, or a socket proxy that only allows `create`, `start`, `stop`, `kill`, `exec`, `wait`, `delete` and `list` filtered by our label. Either way this needs a separate, reviewed change that updates the guard's allowlist with a justification.
2. **API key path.** Option A keeps it in the server process (as `claudeAgent.ts` already requires). Anything that moves the session into the container reopens this.
3. **Docker Desktop on macOS** runs containers in a Linux VM. Bind mounts go through a file-sharing layer: slower, different symlink and permission semantics (user ids are mapped), and a workspace outside the shared paths is invisible. The behaviour of "symlink escapes" has to be tested on macOS and on Linux separately.
4. **Windows** is not designed for. Paths, `\` handling in `checkPathInWorkspace` and bind mounts all differ; treat Windows as unsupported for the sandbox until someone needs it.
5. **User ids on Linux bind mounts.** Files written by uid 10001 in the container are owned by that uid on the host. Options: run the container with the host user's uid and gid, or fix ownership after the task. Needs a decision with a real Linux host.
6. **Output caps.** Mapping `MAX_MESSAGE_BYTES` and `MAX_TASK_OUTPUT_BYTES` to container output means the server must read the streams and kill the container itself, since `--log-opt max-size` applies to log files, not to a stream the server is reading.
7. **Image supply and updates.** A pinned base image is a dependency to track and rebuild; where the image is built (and that the build has network but the run does not) needs a procedure.
8. **TOCTOU with SDK built-in tools.** Closed only if built-in tools are disabled and replaced by gated in-process tools (option A). Until then the use-time re-check and the real file access remain two steps.
9. **Testing.** Real isolation can only be tested where Docker runs. The unit tests can cover the command construction (flags, mounts, environment, no socket, no extra mounts) without Docker, but "the container cannot reach the network or the host" needs an integration test that skips when Docker is absent. Not run here.
10. **Resource exhaustion on the host.** Limits are per container; many tasks at once are bounded today by one active task per agent, but there is no global cap. A global limit on concurrent containers is part of the design.

## What is not claimed

- No container is started anywhere in the code today.
- The README and the security boundaries describe policy checks only.
- Even with this design implemented, it is isolation for one local user, not a multi-tenant boundary: a Docker escape or a kernel bug defeats it, and the server's Docker access is a high-value target (blocker 1).

## Implementation checklist for 3B.2 and later

- [ ] Decide blocker 1 (Engine API over the socket vs CLI; rootless or socket proxy) and the guard exception.
- [ ] Pure `buildContainerSpec(workspacePath, task, limits)` with unit tests for every flag, the single mount, the environment allowlist, and the absence of the socket and extra mounts.
- [ ] `Sandbox` interface (`start`, `exec`, `stop`, `sweep`) with a fake for tests; the Docker implementation behind it.
- [ ] Start-up sweep by label, and cleanup on cancel, timeout, task end and shutdown.
- [ ] Output counting and kill at the cap.
- [ ] In-process SDK MCP tools for the six catalogue tools whose handlers call `ctx.tools.use(..., perform)`; built-in tools disabled.
- [ ] A global cap on concurrent containers.
- [ ] Integration tests that run only when Docker is available (network blocked, host files unreachable, symlink out of the workspace, limits enforced, cleanup after a crash), on macOS and Linux.
- [ ] Update the README security section only when each item above is implemented and tested.
