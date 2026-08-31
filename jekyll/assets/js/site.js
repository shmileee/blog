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
    if (!progress || !toTop) return;

    let scheduled = false;
    const render = () => {
      const available = document.documentElement.scrollHeight - window.innerHeight;
      const ratio = available > 0 ? Math.min(window.scrollY / available, 1) : 0;
      progress.style.transform = `scaleX(${ratio})`;
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

  setupTheme();
  setupScrollUI();
})();
