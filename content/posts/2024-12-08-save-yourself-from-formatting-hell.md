---
title: Save yourself from formatting hell
description: Two kinds of pre-commit hook, the ones that fix and the ones that only complain, and why the first commit after adding them fails on purpose.
date: 2024-12-08 12:00:00
categories:
  - pre-commit
  - devex
---

Markdown accumulates small inconsistencies, trailing spaces, doubled blank
lines, a heading with no blank line under it, and they surface in diffs and
reviews where nobody wanted to talk about them. The
[pre-commit framework](https://pre-commit.com/) runs formatters and linters
on the staged files before every commit, so they never reach the diff. The
setup is ten lines; the part worth a post is what happens on the first commit
after adding it.

> [!NOTE] Versions
>
> `pre-commit-hooks` v4.6.0 and `markdownlint-cli` v0.42.0, as pinned below.
> The transcripts are from a scratch repository with one Markdown file in it.

## The configuration

One file at the repository root names the hooks and pins their versions:

```yaml title=".pre-commit-config.yaml"
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.6.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer

  - repo: https://github.com/igorshubovych/markdownlint-cli
    rev: v0.42.0
    hooks:
      - id: markdownlint
```

`pip install pre-commit` (or your package manager) installs the framework,
and `pre-commit install` writes `.git/hooks/pre-commit` in the clone, which
is what makes the hooks run on `git commit`.

## Two kinds of hook

A hook is a program that receives the staged file names and exits non-zero
to block the commit. The two hooks from `pre-commit-hooks` are *fixers*: they
rewrite the file and exit non-zero, so the commit stops and the fix is
already in the working tree. `markdownlint`, as configured above, is a
*checker*: it reports and leaves the file alone. The difference shows on the
first run. Take a file with three trailing spaces after “space”, two blank
lines in a row, a heading with no blank line under it and no newline at the
end:

```markdown title="docs/README.md"
# Notes

Some text with trailing space


## Heading without a blank line after
Next line
```

`pre-commit run --all-files` runs every hook on every file, which is how a
newly added configuration is tried out:

```text
pre-commit run --all-files
# trim trailing whitespace.......................................Failed
# - hook id: trailing-whitespace
# - exit code: 1
# - files were modified by this hook
#
# Fixing docs/README.md
#
# fix end of files...............................................Failed
# - hook id: end-of-file-fixer
# - exit code: 1
# - files were modified by this hook
#
# Fixing docs/README.md
#
# markdownlint...................................................Failed
# - hook id: markdownlint
# - exit code: 1
#
# docs/README.md:5 MD012/no-multiple-blanks Multiple consecutive blank lines [Expected: 1; Actual: 2]
# docs/README.md:6 MD022/blanks-around-headings Headings should be surrounded by blank lines [Expected: 1; Actual: 0; Below] [Context: "## Heading without a blank line after"]
```

All three failed, for two different reasons. The fixers failed *because they
changed the file*: `git status` now shows `AM docs/README.md`, the staged
copy still carrying the whitespace and the working copy without it. Staging
again and re-running is the whole remedy for a fixer. The checker failed
because the file has two problems it will not touch, and re-running reports
them again:

```text
git add docs/README.md
pre-commit run --all-files
# trim trailing whitespace.......................................Passed
# fix end of files...............................................Passed
# markdownlint...................................................Failed
# - hook id: markdownlint
# - exit code: 1
#
# docs/README.md:5 MD012/no-multiple-blanks Multiple consecutive blank lines [Expected: 1; Actual: 2]
# docs/README.md:6 MD022/blanks-around-headings Headings should be surrounded by blank lines [Expected: 1; Actual: 0; Below] [Context: "## Heading without a blank line after"]
```

Both of those rules are ones markdownlint can fix, and one argument turns
the checker into a fixer:

```yaml title=".pre-commit-config.yaml"
      - id: markdownlint
        args: [--fix]
```

```text
pre-commit run --all-files
# trim trailing whitespace.......................................Passed
# fix end of files...............................................Passed
# markdownlint...................................................Failed
# - hook id: markdownlint
# - files were modified by this hook

git add docs/README.md
pre-commit run --all-files
# trim trailing whitespace.......................................Passed
# fix end of files...............................................Passed
# markdownlint...................................................Passed
```

So the first commit after adding hooks fails on purpose, once per fixer that
found something, and the second one goes through. Which hooks to make fixers
is a choice: a formatter should fix, because nobody wants to hand-apply its
opinion; a rule that needs a judgement call should report, so the author
makes it.

## Start with two hooks

The configuration above is a good first set: it changes nothing anyone
disagrees with. A linter with a hundred rules on day one produces a
hundred-line report on the first commit and gets disabled by lunchtime. Add
a rule when a review comment shows the need for it.

## Limitations

The hooks run only in a clone where `pre-commit install` has been run, and
`git commit --no-verify` skips them. The same `pre-commit run --all-files`
in continuous integration is what makes them a rule rather than a
convention, and its environment setup wants `~/.cache/pre-commit` cached
between runs.

The `rev` pins go stale. `pre-commit autoupdate` moves them to the latest
tags; Renovate can open the pull request.

The first `--all-files` run on an existing repository rewrites every file the
fixers disagree with. That is one large formatting commit, best made on its
own before anyone else’s branch has to rebase over it.
