# blog

Markdown content repository for the blog section of [oponomarov.com](https://oponomarov.com/). It contains no site code, build tooling, or templates — only content. The site is **rendered by [shmileee/oponomarov.com](https://github.com/shmileee/oponomarov.com)** (the Astro engine), which pulls this repository at build time and publishes the blog under `/blog/`.

Pushes to `main` trigger `.github/workflows/notify-engine.yaml`, which dispatches a `blog-updated` event so the engine rebuilds with the latest content.

## Layout

- `content/posts/` — one Markdown file per post
- `content/static/` — images and other assets referenced by posts

## Filename convention (do not rename posts)

Post filenames MUST follow `YYYY-MM-DD-slug.md` (for example `2026-03-04-opencode-tmux-notifications.md`). The engine's `src/lib/posts.ts` derives both the post's URL slug and its publication date from the filename, so renaming a file changes its URL and date.

## Frontmatter contract (posts collection)

YAML frontmatter validated by the engine's `posts` collection schema:

| Field         | Type                         | Notes                                   |
| ------------- | ---------------------------- | --------------------------------------- |
| `title`       | string                       | Post title                              |
| `description` | string                       | One-line summary used for meta and RSS  |
| `date`        | date (`YYYY-MM-DD HH:MM:SS`) | Publication timestamp                   |
| `categories`  | string or list of strings    | Category archive membership             |

Post bodies are Astro-flavored Markdown; GitHub-style callout blockquotes (`> [!NOTE]` etc.) render as semantic admonitions.

## Static assets

Files in `content/static/` are materialized by the engine and served at `/blog-static/<filename>`. Reference them from posts with absolute paths, for example `src="/blog-static/opencode-tmux-notification.png"`.
