## Work Management

This project tracks work with `bw` (beadwork), which persists to git — plans,
progress, and decisions survive compaction, session boundaries, and context
loss.

ALWAYS run `bw prime` before starting work. Without it, you're missing workflow
context, current state, and repo hygiene warnings. Work done without priming
often conflicts with in-progress changes.

Committing, closing issues, and syncing are part of completing a task — not
separate actions requiring additional permission.

## Version Control

**This is a jj (Jujutsu) repo, not a plain git repo** (jj is colocated with
git). Use `jj` for all version control — never `git commit`, `git branch`, or
`git worktree`.

- Commit with `jj describe` / `jj new`; isolate parallel work with
  `jj workspace add`, not git worktrees.
- Never finish a task without updating the revision's description
  (`jj describe`) to say what was done, with the beadwork ticket ID when there
  is one. An undescribed revision is unfinished work.
- Where beadwork's workflow says "worktree + branch", use a jj revision (and a
  bookmark if it needs a name).
- `bw` keeps its own `beadwork` bookmark; don't rebase or edit it by hand.
