# Docker and Podman overview

Open **Settings → Execution → Containers** and choose **Refresh status**. The overview groups saved profiles sharing a host and engine endpoint, shows existing containers, and checks each profile's existing image. Filter by computer or search by container name, image, ID or state. Remote profiles use their configured SSH host and fixed Python helper. No separate Docker TCP listener is required.

The overview is on demand. It does not pull images or start engines/virtual machines. Concurrent checks share bounded probes; main-process facts have a five-second cache, and the refresh button requests fresh facts. Leaving the view discards late replies. Only supported, verified engine endpoints are shown as available.

Up to 64 recent containers are shown per engine. A notice identifies incomplete coverage. Rows expose only ID, name, image, state and status. Engine command lines, environment, mounts and raw diagnostic output are excluded. An unavailable image does not hide a readable engine inventory.

“CanvasTTY record” identifies an exact saved generation on the selected profile, endpoint and engine. This badge is informational. Overview rows have no start, stop or remove actions. Existing retained-generation controls still perform their full ownership and current-identity checks before cleanup or output review. Other containers remain read only.

The read-only commands use documented projection and row limits: [Docker container ls](https://docs.docker.com/reference/cli/docker/container/ls/) and [Podman ps](https://docs.podman.io/en/latest/markdown/podman-ps.1.html). Local and SSH execution share the same projected fields, strict response validation and engine identity checks around listing.

## Automatic launch across computers

In an agent's launcher choose **Containers → Automatically by load**. Leave the account as **Any eligible API account**, or select one to constrain placement. **Check route** shows the current profile, computer, account, effective model/data class and bounded reasons other candidates were excluded. Launch reevaluates current settings and load; the preview does not reserve resources. The created session's notice and container badge use its actual fixed route.

Only saved profiles with an existing available image and compatible fixed API account are eligible. Provider commands, network, model/data policies, project mappings, account limits and session/resource capacity are checked before ranking. An account stays on its saved computer. Different services may coexist there; the normal one-account limit or explicitly configured two-account limit per service remains in force. Remote API credentials must already be provisioned on their matching server. No account keys or homes are copied, no images downloaded, and no host fallback occurs if selection fails.

Automatic placement uses full Git worktrees and ordinary PTY container launches. Selected-file capsules keep their explicit local profile. ACP remains local direct/worktree. Restart uses the already selected fixed route; it does not run placement again.

Scoped agents can request the same route through `spawn_agent` with `isolation: "container"`, `containerRoute: "auto"` and optional `containerProfileIds`. They may also constrain `accountId` and `model`. A fixed `host`, `containerProfileId` or `worktreeRef` cannot be combined with automatic container placement. The result includes selected host, account and isolation IDs.
