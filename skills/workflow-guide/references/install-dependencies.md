# Install Dependencies

Cited by every skill that changes what is on disk — creating a worktree, checking out or rebasing a
branch, or pulling main. `cd` to the target directory first, then install there.
Consumer skills cite this file and keep only their own parameters — don't restate the guidance in a
skill file.

**Install with whatever the repo actually uses.** Look at what the repo has and run that tool's
install: `pnpm install`, `yarn install`, `npm install` or `bun install` for a JS lockfile,
`go mod download` for a Go module, `cargo build` for Cargo, and `uv sync`, `poetry install`,
`pipenv install` or `pip install -r requirements.txt` for Python. These are examples, not a closed
set — a repo using something else gets that thing's install command.

**When a repo carries more than one marker, use the most specific one.** A `Pipfile` means pipenv
even with a `pyproject.toml` beside it; a `uv.lock` means uv rather than poetry. Pick the tool the
repo is actually managed by, not the first plausible match.

**In a pnpm worktree, drop the symlinked `node_modules` first** — `[ -L node_modules ] && rm node_modules`
— then install fresh. The symlink makes tools like eslint fail.

**Warn, don't block.** If the install command exits non-zero, show the command's own failing output
plus an explicit `dependency install failed` line, then carry on. A failed install never holds up the
work the caller was doing, teardown included.

**Never run `pnpm store prune` as a remedy** — it clears cached auth tokens for private registries and
forces re-authentication. Use `pnpm install --force` or delete `node_modules` instead. This holds
wherever a dependency problem is being remedied, not just here.
