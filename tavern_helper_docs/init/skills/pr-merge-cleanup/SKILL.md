# PR Merge and Cleanup

Use this skill after a pull request has been tested locally and the user is
ready to merge, clean up branches, and remove worktrees.

## Purpose

Provide a safe, repeatable flow for merging a reviewed PR, deleting the remote
branch, switching back to the default branch, and removing the associated
worktree -- without leaving orphaned branches or worktrees behind.

## When To Use

Use this skill when:

- The user confirms a PR is ready to merge after local testing
- The user asks to "merge and clean up"
- A PR was already merged but branches or worktrees were not removed

Do not use this skill when:

- The PR is still in review or needs changes
- The user explicitly wants to keep the branch or worktree

## Workflow

1. Identify the PR to merge.

   ```sh
   gh pr view <number> --json number,title,headRefName,state
   ```

   Confirm the PR number with the user if not already known.

2. Verify PR checks pass (if any).

   ```sh
   gh pr checks <number>
   ```

   If checks are failing, ask the user whether to proceed anyway.

3. Merge the PR.

   ```sh
   gh pr merge <number> --merge --delete-branch
   ```

   Use `--squash` instead of `--merge` if the user prefers squash merges.

4. Switch to the default branch and pull.

   ```sh
   git switch <default-branch>
   git pull --ff-only
   ```

5. Remove the local task branch if it still exists.

   ```sh
   git branch -D <branch-name>
   ```

6. Remove the worktree if one was created for this task.

   ```sh
   git worktree remove <worktree-path>
   ```

   If the worktree directory was already deleted manually, prune instead:

   ```sh
   git worktree prune
   ```

7. Prune stale remote tracking branches.

   ```sh
   git remote prune origin
   ```

8. Report final state.

```text
PR: <number> -- merged
Branch: <branch-name> -- deleted
Worktree: <path> -- removed
Default branch: <default-branch> @ <commit-hash>
```

## Guardrails

- Never force-push or reset the default branch.
- Never delete a branch that has unmerged changes without confirming with the
  user.
- If `gh` is not authenticated, fall back to merging via the GitHub web UI and
  clean up locally afterward.
- Always confirm the PR number before merging.
- If the worktree has uncommitted changes, ask the user before removing it.
