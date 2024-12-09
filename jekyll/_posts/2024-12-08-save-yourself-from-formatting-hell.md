---
layout: post
title: "Save Yourself From Formatting Hell"
date: 2024-12-08 12:00:29 +0100
categories:
  - pre-commit
  - developer-tools
---

There's something quietly maddening about formatting: it's so trivial and yet
so easy to forget. Markdown especially tends to accumulate trivial
inconsistencies — extra spaces, trailing whitespace, messed-up headings. And
when you share your docs with others, those tiny differences always show up in
diffs and code reviews, consuming cognitive load that should be spent on more
interesting work.

So the question: how do we fix this? How do we ensure that docs (and other text
files) remain consistently formatted without mentally checking and re-checking
every time we commit?

**Enter `pre-commit` hooks.**

The [pre-commit framework](https://pre-commit.com/) is a system to manage and
maintain a set of Git pre-commit hooks. It basically gives you a neat,
centralized place to declare all the formatting and linting rules you want to
run before every commit. Instead of remembering to manually run `markdownlint`
or `prettier` (or any number of tools), `pre-commit` does it for you.

### Why Bother?

1. **Consistency:** You might think you’ll remember to run your formatters
   every time, but you won’t. Humans are lazy, and that’s good. Offload the
   task to a machine. Machines are perfect at being pedantic.

2. **Reduce Noise in Diffs:** Random whitespace changes, inconsistent headers,
   or different markdown link styles all create needless diff clutter. With
   consistent auto-formatting, your diffs focus on meaningful changes, not nits.

3. **Team Harmony:** If you work with others, you can preempt a lot of “Could
   you fix the formatting?” comments by making the formatting fix itself before
   any commit even gets made. It’s a subtle gift to your future self and your
   colleagues.

### Getting Started

If you haven’t tried it out, installing and using `pre-commit` is
straightforward:

```bash
pip install pre-commit
```

Add a `.pre-commit-config.yaml` to your repository. For example, let’s say you
want to auto-format your files by removing trailing whitespaces and also ensure
that your docs are linted with a tool like `markdownlint`:

```yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.6.0
    hooks:
      - id: end-of-file-fixer
      - id: mixed-line-ending

  - repo: https://github.com/igorshubovych/markdownlint-cli
    rev: v0.42.0
    hooks:
      - id: markdownlint
```

Then just run:

```bash
pre-commit install
```

From now on, whenever you commit changes to your `.md` files, `pre-commit` will
auto-format them and lint them. If something’s off, it’ll fix it or block the
commit until you fix it.

### Don’t Overcomplicate It

One nice aspect of `pre-commit` is that you can start small. Add a simple
formatter hook. Once you trust it, add a linter. Over time you might expand to
check broken links, validate YAML frontmatter, or even run a spell checker. But
keep your initial setup small and easy. The tool should relieve friction, not
add to it.

### Conclusion

This might feel like a small optimization, but it’s really about mental load.
You want to stop thinking about formatting rules and focus on content and
logic. Let `pre-commit` handle the grunt work. After a few weeks, you’ll wonder
how you ever lived without it.
