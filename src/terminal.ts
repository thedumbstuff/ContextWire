// One xterm.js terminal per session, kept alive while hidden so output and
// scrollback survive switching between sessions.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

const THEME = {
  background: "#0f1216",
  foreground: "#d9dee5",
  cursor: "#d9dee5",
  selectionBackground: "#3a4656",
  black: "#1b2028", brightBlack: "#5b6574",
  red: "#f0524f", brightRed: "#ff7b78",
  green: "#3fb95f", brightGreen: "#5fd47c",
  yellow: "#e3a526", brightYellow: "#f2c15a",
  blue: "#4c9aff", brightBlue: "#7bb6ff",
  magenta: "#a974f0", brightMagenta: "#c49bff",
  cyan: "#39c5cf", brightCyan: "#6ee0e8",
  white: "#d9dee5", brightWhite: "#ffffff",
};

export class TermHost {
  readonly el: HTMLDivElement;
  private term: Terminal;
  private fit = new FitAddon();
  private opened = false;
  private lastSize = "";

  constructor(readonly id: string, parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "term hidden";
    parent.appendChild(this.el);
    this.term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.1,
      scrollback: 10000,
      cursorBlink: true,
      allowProposedApi: true,
      theme: THEME,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon((_e, uri) => { openUrl(uri).catch(() => {}); }));
    this.term.onData((data) => this.send(data));
    this.term.onBinary((data) => this.send(data));
    this.term.onResize(({ cols, rows }) => {
      invoke("session_resize", { id: this.id, cols, rows }).catch(() => {});
    });
    // Windows-style clipboard: Ctrl+C copies when text is selected (else ^C
    // goes to Claude), Ctrl+V / Ctrl+Shift+V paste.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === "c" && (e.shiftKey || this.term.hasSelection())) {
        navigator.clipboard.writeText(this.term.getSelection()).catch(() => {});
        this.term.clearSelection();
        return false;
      }
      if (e.ctrlKey && k === "v") return false; // let the browser paste event reach xterm
      return true;
    });
    this.term.open(this.el);
    this.opened = true;
  }

  private send(data: string) {
    invoke("session_write", { id: this.id, data }).catch(() => {});
  }

  /** Current size, for spawning the PTY at the right dimensions. */
  size(): { cols: number; rows: number } {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  write(bytes: Uint8Array) {
    this.term.write(bytes);
  }

  /** Paste as if typed with Ctrl+V: bracketed when the app asked for it, so
   *  Claude treats it as a paste (and turns image paths into attachments). */
  paste(text: string) {
    this.term.paste(text);
    this.term.focus();
  }

  notice(text: string) {
    this.term.write(`\r\n\x1b[90m── ${text} ──\x1b[0m\r\n`);
  }

  show() {
    this.el.classList.remove("hidden");
    this.refit();
    this.term.focus();
  }

  hide() {
    this.el.classList.add("hidden");
  }

  focus() {
    this.term.focus();
  }

  refit() {
    if (!this.opened || this.el.classList.contains("hidden")) return;
    try {
      this.fit.fit();
    } catch {
      /* not laid out yet */
    }
    const s = `${this.term.cols}x${this.term.rows}`;
    if (s !== this.lastSize) {
      this.lastSize = s;
      invoke("session_resize", { id: this.id, cols: this.term.cols, rows: this.term.rows }).catch(() => {});
    }
  }

  dispose() {
    this.term.dispose();
    this.el.remove();
  }
}
