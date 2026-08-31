---
title: OpenCode + tmux Notifications for Idle Agents
description: Mark waiting tmux windows and send quiet macOS notifications when an OpenCode agent needs attention.
layout: post
date: 2026-03-04 09:00:00
categories:
  - opencode
  - tmux
  - developer-tools
---

This post started after a knowledge-sharing session inside my team at work about
how we use AI, LLMs, and agents in daily workflows.

Someone shared [PeonPing](https://www.peonping.com), which is genuinely fun and
well-built. I tried it, liked it, and then realized it was a bit _too_ fun for
my own day-to-day use: sounds pulled my attention away from whatever else I was
doing while agents were running in the background.

So I went for a quieter setup and built a tiny OpenCode plugin instead, mostly
because writing a small plugin sounded fun and practical at the same time.

I use [Alacritty](https://alacritty.org) on macOS and keep multiple
[OpenCode](https://opencode.ai) sessions in separate
[tmux](https://github.com/tmux/tmux) windows. The problem: when one session
turns idle, I know _something_ finished, but not _which window_ needs input.

## OpenCode Plugins in 30 Seconds

[OpenCode plugins](https://opencode.ai/docs/plugins) are small TypeScript
modules that subscribe to OpenCode events (`session.idle`, `session.status`,
`permission.ask`, etc.) and run custom logic when those events fire.

This setup solves two things at once:

1. A system notification on macOS when input is needed,
2. A subtle marker (`●`) in tmux window list for the exact waiting session.

The end result looks like this:

<figure class="media-figure media-figure-wide">
  <div class="media-frame media-frame-dark media-frame-scroll" tabindex="0" role="region" aria-label="Scrollable tmux status-line screenshot">
    <img
      src="{{ '/static/opencode-tmux-notification.png' | relative_url }}"
      alt="tmux status line showing the waiting marker"
    />
  </div>
  <figcaption>
    1. tmux window list with a light ● marker on the opencode session that is waiting for input
  </figcaption>
</figure>

<figure class="media-figure media-figure-compact">
  <div class="media-frame media-frame-light">
    <img
      src="{{ '/static/opencode-macos-notification.png' | relative_url }}"
      alt="macOS notification for OpenCode"
    />
  </div>
  <figcaption>
    2. popup notification with the tmux window label that needs attention
  </figcaption>
</figure>

## Plugin Walkthrough

> 💡 Full gist: [https://gist.github.com/shmileee/f8b9d0e380a53055e14fe6403c86e2cf](https://gist.github.com/shmileee/f8b9d0e380a53055e14fe6403c86e2cf)

Save the plugin as `~/.config/opencode/plugins/tmux-window-notification.ts`.

### 1) Resolve the correct tmux window

The plugin pins itself to the pane where OpenCode started. Without that,
notifications can point to whichever tmux window is currently active when the
event happens.

```ts
const getPaneFromEnv = async (): Promise<string | null> => {
  try {
    const result = await $`printenv TMUX_PANE`.text();
    const pane = result.trim();
    return pane.length > 0 ? pane : null;
  } catch {
    return null;
  }
};

const getWindowId = async (tmuxPane: string | null): Promise<string | null> => {
  if (!tmuxPane) return null;

  try {
    const result =
      await $`tmux display-message -p -t ${tmuxPane} '#{window_id}'`.text();
    const windowId = result.trim();
    return windowId.length > 0 ? windowId : null;
  } catch {
    return null;
  }
};

const getWindowLabel = async (
  tmuxPane: string | null,
): Promise<string | null> => {
  if (!tmuxPane) return null;

  try {
    const result =
      await $`tmux display-message -p -t ${tmuxPane} '#S:#I #{window_name}'`.text();
    const label = result.trim();
    return label.length > 0 ? label : null;
  } catch {
    return null;
  }
};
```

### 2) Set / clear a waiting marker in tmux

Remove the waiting marker whenever the window gains focus.

```ts
const TMUX_WAITING_OPTION = "@opencode_waiting";
const TMUX_WAITING_SYMBOL = "●";
let waitingState: boolean | null = null;

const setWaitingIndicator = async (
  tmuxWindowId: string | null,
  waiting: boolean,
  force: boolean = false,
): Promise<void> => {
  if (!tmuxWindowId) return;
  if (!force && waitingState === waiting) return;

  try {
    if (waiting) {
      await $`tmux set-window-option -q -t ${tmuxWindowId} ${TMUX_WAITING_OPTION} ${TMUX_WAITING_SYMBOL}`;
    } else {
      await $`tmux set-window-option -q -u -t ${tmuxWindowId} ${TMUX_WAITING_OPTION}`;
    }
    waitingState = waiting;
  } catch {
    // Ignore tmux update failures.
  }
};
```

### 3) Send macOS notification

You get desktop notifications when away, but no popup noise when Alacritty is
already focused.

```ts
const isAlacrittyFocused = async (): Promise<boolean> => {
  try {
    const result =
      await $`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`.text();
    return /alacritty/i.test(result.trim());
  } catch {
    return false;
  }
};

const notify = async (message: string): Promise<void> => {
  await $`osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title (item 2 of argv) sound name "Pop"' -e 'end run' ${message} ${NOTIFICATION_TITLE}`;
};

return {
  event: async ({ event }) => {
    if (event.type === "session.status") {
      const status = event.properties?.status;
      const statusType = typeof status === "object" ? status?.type : status;
      if (statusType === "busy") {
        await setWaitingIndicator(tmuxWindowId, false);
      }
      return;
    }

    if (event.type === "permission.updated") {
      await setWaitingIndicator(tmuxWindowId, true);
      return;
    }

    if (event.type !== "session.idle") return;

    await setWaitingIndicator(tmuxWindowId, true);
    if (await isAlacrittyFocused()) return;

    const windowLabel = await getWindowLabel(tmuxPane);
    await notify(
      windowLabel
        ? `Waiting for input in ${windowLabel}`
        : "Waiting for your input",
    );
  },

  "permission.ask": async () => {
    await setWaitingIndicator(tmuxWindowId, true);
  },

  "chat.message": async () => {
    await setWaitingIndicator(tmuxWindowId, false);
  },
};
```

## Relevant `tmux.conf` Snippet

```text
# show waiting marker in window list
setw -g window-status-current-format ' #{?@opencode_waiting,#[fg=colour153]#{@opencode_waiting} ,}#I#[fg=colour250]:#[fg=colour255]#W#[fg=colour50]#F '
setw -g window-status-format ' #{?@opencode_waiting,#[fg=colour153]#{@opencode_waiting} ,}#I#[fg=colour237]:#[fg=colour250]#W#[fg=colour244]#F '

# clear marker when you focus/switch windows
set-hook -g after-select-window 'set-window-option -q -u @opencode_waiting'
set-hook -g session-window-changed 'set-window-option -q -u @opencode_waiting'
set-hook -g client-focus-in 'set-window-option -q -u @opencode_waiting'
```

The end result is exactly what I wanted: if an agent is waiting, I can spot the
right tmux window instantly, and I still get desktop alerts when I am away from
terminal focus.
