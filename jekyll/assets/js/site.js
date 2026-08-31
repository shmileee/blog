(() => {
  const root = document.documentElement;

  const setupTheme = () => {
    const button = document.querySelector("[data-theme-toggle]");
    if (!button) return;

    const render = () => {
      const theme = root.dataset.theme === "light" ? "light" : "dark";
      const nextTheme = theme === "dark" ? "light" : "dark";
      button.textContent = nextTheme;
      button.setAttribute("aria-label", `Switch to ${nextTheme} color scheme`);
    };

    button.addEventListener("click", () => {
      const theme = root.dataset.theme === "dark" ? "light" : "dark";
      root.dataset.theme = theme;
      localStorage.setItem("om-theme", theme);
      window.dispatchEvent(new CustomEvent("om-theme-change", { detail: theme }));
      render();
    });

    render();
  };

  const setupScrollUI = () => {
    const progress = document.querySelector("[data-reading-progress]");
    const toTop = document.querySelector("[data-back-to-top]");
    if (!toTop) return;

    let scheduled = false;
    const render = () => {
      const available = document.documentElement.scrollHeight - window.innerHeight;
      const ratio = available > 0 ? Math.min(window.scrollY / available, 1) : 0;
      if (progress) progress.style.transform = `scaleX(${ratio})`;
      toTop.dataset.visible = String(window.scrollY > 640);
      scheduled = false;
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(render);
    };

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
    render();
  };

  const setupArticleToc = () => {
    const toc = document.querySelector("[data-article-toc]");
    const list = toc?.querySelector("[data-article-toc-list]");
    const select = toc?.querySelector("[data-article-toc-select]");
    const headings = [...document.querySelectorAll(".post-detail .prose h2, .post-detail .prose h3")];
    if (!toc || !list || !select || headings.length < 3) return;

    const usedIds = new Set([...document.querySelectorAll("[id]")].map((element) => element.id));
    const fragment = document.createDocumentFragment();
    const links = [];

    headings.forEach((heading, index) => {
      if (!heading.id) {
        const base = heading.textContent
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || `section-${index + 1}`;
        let candidate = base;
        let suffix = 2;
        while (usedIds.has(candidate)) candidate = `${base}-${suffix++}`;
        heading.id = candidate;
        usedIds.add(candidate);
      }

      const item = document.createElement("li");
      item.className = heading.tagName === "H3" ? "is-subsection" : "is-section";
      const link = document.createElement("a");
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent.trim();
      link.addEventListener("click", () => {
        links.forEach((tocLink) => {
          tocLink.classList.toggle("is-active", tocLink === link);
          if (tocLink === link) tocLink.setAttribute("aria-current", "location");
          else tocLink.removeAttribute("aria-current");
        });
      });
      links.push(link);
      item.append(link);
      fragment.append(item);

      const option = document.createElement("option");
      option.value = `#${heading.id}`;
      option.textContent = `${heading.tagName === "H3" ? "— " : ""}${heading.textContent.trim()}`;
      select.append(option);
    });

    list.append(fragment);
    toc.hidden = false;

    let scheduled = false;
    const renderActiveSection = () => {
      const activationOffset =
        Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) +
        Number.parseFloat(getComputedStyle(headings[0]).scrollMarginTop) +
        1;
      const activeHeading = [...headings]
        .reverse()
        .find((heading) => heading.getBoundingClientRect().top <= activationOffset);

      links.forEach((link, index) => {
        const active = headings[index] === activeHeading;
        link.classList.toggle("is-active", active);
        if (active) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
      select.value = activeHeading ? `#${activeHeading.id}` : "";
      scheduled = false;
    };

    const scheduleActiveSection = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(renderActiveSection);
    };

    select.addEventListener("change", () => {
      if (!select.value) return;
      const target = document.querySelector(select.value);
      if (!target) return;
      window.location.hash = target.id;
      select.blur();
    });
    window.addEventListener("scroll", scheduleActiveSection, { passive: true });
    renderActiveSection();
  };

  const setupCodeExhibits = () => {
    const languageNames = {
      bash: "Shell",
      sh: "Shell",
      shell: "Shell",
      console: "Terminal",
      hcl: "Terraform / HCL",
      terraform: "Terraform / HCL",
      yaml: "YAML",
      yml: "YAML",
      ts: "TypeScript",
      typescript: "TypeScript",
      js: "JavaScript",
      javascript: "JavaScript",
      json: "JSON",
      html: "HTML",
      css: "CSS",
      text: "Text",
      plaintext: "Text",
    };

    const copyText = async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.append(textarea);
        textarea.select();

        try {
          return document.execCommand("copy");
        } finally {
          textarea.remove();
        }
      }
    };

    document.querySelectorAll(".prose div.highlighter-rouge").forEach((wrapper, index) => {
      if (wrapper.dataset.codeEnhanced === "true") return;
      const highlight = wrapper.querySelector(":scope > div.highlight");
      const pre = highlight?.querySelector(":scope > pre");
      const code = pre?.querySelector("code");
      if (!highlight || !pre || !code) return;

      const languageClass = [...wrapper.classList].find((name) => name.startsWith("language-"));
      const language = languageClass?.slice("language-".length) || "text";
      const languageName = languageNames[language] || language.toUpperCase();
      const lineCount = Math.max(code.textContent.replace(/\n$/, "").split("\n").length, 1);

      const toolbar = document.createElement("div");
      toolbar.className = "code-exhibit-toolbar";

      const dots = document.createElement("span");
      dots.className = "code-exhibit-dots";
      dots.setAttribute("aria-hidden", "true");
      dots.innerHTML = "<i></i><i></i><i></i>";

      const details = document.createElement("span");
      details.className = "code-exhibit-details";
      const label = document.createElement("span");
      label.className = "code-exhibit-language";
      label.textContent = languageName;
      const lines = document.createElement("span");
      lines.className = "code-exhibit-lines";
      lines.textContent = `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
      details.append(label, lines);

      const copy = document.createElement("button");
      copy.className = "code-copy";
      copy.type = "button";
      copy.textContent = "copy";
      copy.setAttribute("aria-label", `Copy ${languageName} code`);
      copy.setAttribute("aria-live", "polite");
      let resetTimer;

      const resetCopyButton = () => {
        copy.textContent = "copy";
        delete copy.dataset.copied;
        copy.setAttribute("aria-label", `Copy ${languageName} code`);
      };

      copy.addEventListener("click", async () => {
        window.clearTimeout(resetTimer);

        try {
          if (!(await copyText(code.textContent))) throw new Error("Copy failed");
          copy.textContent = "copied";
          copy.dataset.copied = "true";
          copy.setAttribute("aria-label", `${languageName} code copied`);
          resetTimer = window.setTimeout(resetCopyButton, 1800);
        } catch {
          copy.textContent = "try again";
          copy.setAttribute("aria-label", `Copy ${languageName} code; try again`);
          resetTimer = window.setTimeout(resetCopyButton, 1800);
        }
      });

      toolbar.append(dots, details, copy);
      wrapper.insertBefore(toolbar, highlight);
      wrapper.classList.add("code-exhibit");
      wrapper.dataset.codeEnhanced = "true";
      pre.removeAttribute("role");

      const syncScrollableState = () => {
        const scrollable = pre.scrollWidth > pre.clientWidth + 1;
        if (scrollable) {
          pre.tabIndex = 0;
          pre.setAttribute("aria-label", `${languageName} code example ${index + 1}; horizontally scrollable`);
        } else {
          pre.removeAttribute("tabindex");
          pre.removeAttribute("aria-label");
        }
      };

      window.requestAnimationFrame(syncScrollableState);
      window.addEventListener("resize", syncScrollableState);
    });
  };

  setupTheme();
  setupScrollUI();
  setupArticleToc();
  setupCodeExhibits();
})();
