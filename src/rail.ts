// PyCharm-style tool-window rail: icon tabs on the far left switch the panel;
// clicking the open tab again hides the panel. Alt+1..6 do the same.

export type PanelId = "active" | "all" | "git" | "roadmaps" | "activity" | "search";

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const PANELS: { id: PanelId; label: string; icon: string }[] = [
  { id: "active", label: "Active", icon: svg('<circle cx="12" cy="12" r="3"/><path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>') },
  { id: "all", label: "All Sessions", icon: svg('<path d="M4 5h16M4 12h10M4 19h13"/><circle cx="19" cy="12" r="1.5"/>') },
  { id: "git", label: "Git", icon: svg('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-11.2 6.6"/>') },
  { id: "roadmaps", label: "Roadmaps", icon: svg('<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>') },
  { id: "activity", label: "Activity", icon: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>') },
  { id: "search", label: "Search", icon: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>') },
];

const SETTINGS_ICON = svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>');

export interface RailState {
  panel: PanelId;
  collapsed: boolean;
  width: number;
}

export const MIN_W = 220;
export const MAX_W = 620;

export class Rail {
  constructor(
    private st: RailState,
    private onChange: (st: RailState, opened: PanelId | null) => void,
  ) {
    const rail = document.getElementById("rail")!;
    rail.innerHTML =
      PANELS.map((p, i) => `<button class="rtab" data-panel="${p.id}" title="${p.label} (Alt+${i + 1})" aria-label="${p.label}">${p.icon}<span class="rbadge" id="badge-${p.id}"></span></button>`).join("") +
      `<span class="spacer"></span><button class="rtab" id="btnSettings" title="Settings" aria-label="Settings">${SETTINGS_ICON}</button>`;
    rail.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-panel]");
      if (b) this.toggle(b.dataset.panel as PanelId);
    });
    window.addEventListener("keydown", (e) => {
      if (!e.altKey || e.ctrlKey || e.shiftKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= PANELS.length) {
        e.preventDefault();
        e.stopPropagation();
        this.toggle(PANELS[n - 1].id);
      }
    }, true);
    this.bindSplitter();
    this.apply(null);
  }

  get state(): RailState {
    return this.st;
  }

  /** Open a panel; clicking the open one again hides the panel (PyCharm). */
  toggle(id: PanelId) {
    if (id === this.st.panel && !this.st.collapsed) this.st.collapsed = true;
    else {
      this.st.panel = id;
      this.st.collapsed = false;
    }
    this.apply(this.st.collapsed ? null : id);
  }

  show(id: PanelId) {
    this.st.panel = id;
    this.st.collapsed = false;
    this.apply(id);
  }

  badge(id: PanelId, text: string, kind: "needs" | "unread" | "info" = "info") {
    const el = document.getElementById(`badge-${id}`);
    if (!el) return;
    el.textContent = text;
    el.className = `rbadge${text ? " " + kind : ""}`;
  }

  private apply(opened: PanelId | null) {
    const app = document.getElementById("app")!;
    app.classList.toggle("collapsed", this.st.collapsed);
    app.style.setProperty("--pw", `${this.st.width}px`);
    document.querySelectorAll<HTMLElement>(".rtab[data-panel]").forEach((b) => {
      b.classList.toggle("on", b.dataset.panel === this.st.panel && !this.st.collapsed);
    });
    document.querySelectorAll<HTMLElement>(".pane").forEach((p) => p.classList.toggle("hidden", p.id !== `pane-${this.st.panel}`));
    const meta = PANELS.find((p) => p.id === this.st.panel)!;
    document.getElementById("panelTitle")!.textContent = meta.label;
    this.onChange(this.st, opened);
  }

  private bindSplitter() {
    const sp = document.getElementById("splitter")!;
    sp.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = this.st.width;
      document.body.classList.add("resizing");
      const move = (ev: MouseEvent) => {
        this.st.width = Math.max(MIN_W, Math.min(MAX_W, startW + ev.clientX - startX));
        document.getElementById("app")!.style.setProperty("--pw", `${this.st.width}px`);
      };
      const up = () => {
        document.body.classList.remove("resizing");
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        this.onChange(this.st, null);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
    sp.addEventListener("dblclick", () => {
      this.st.width = 300;
      this.apply(null);
    });
  }
}
