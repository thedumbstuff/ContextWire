// Git panel: every repo under the workspaces, newest change first (toggle),
// with its commits and fetch / pull / push / reword-latest-unpushed actions.

import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../types";
import { ago, basename, norm, rootFor } from "../status";
import { esc } from "../sidebar";

export interface Commit {
  hash: string;
  short: string;
  subject: string;
  body: string;
  author: string;
  time_ms: number;
  pushed: boolean;
}

export interface RepoInfo {
  path: string;
  name: string;
  branch: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: number;
  last_commit: Commit | null;
  last_change_ms: number;
  has_remote: boolean;
  error: string | null;
}

export interface GitCtx {
  roots: () => string[];
  sessions: () => Session[];
  select: (id: string) => void;
  newSessionIn: (cwd: string) => void;
  confirm: (title: string, text: string) => Promise<boolean>;
  log: (level: string, msg: string) => void;
  activity: (kind: string, text: string, cwd: string) => void;
}

const $ = (id: string) => document.getElementById(id)!;

export class GitPanel {
  private repos: RepoInfo[] = [];
  private commits = new Map<string, Commit[]>();
  private open = new Set<string>();
  private busy = new Map<string, string>(); // repo path -> running action
  private notes = new Map<string, { ok: boolean; text: string }>();
  private newestFirst = true;
  private loading = false;
  private loadedAt = 0;
  private rewordTarget: { repo: string; commit: Commit } | null = null;

  constructor(private ctx: GitCtx, prefs: { newestFirst?: boolean }) {
    this.newestFirst = prefs.newestFirst ?? true;
    $("gitList").addEventListener("click", (e) => void this.onClick(e));
    $("gitFilter").addEventListener("input", () => this.render());
    $("rewordGo").addEventListener("click", () => void this.saveReword());
  }

  get prefs() {
    return { newestFirst: this.newestFirst };
  }

  actions(): string {
    return `<button class="mini" data-pa="sort" title="Toggle sort order">${this.newestFirst ? "Newest ↓" : "Oldest ↓"}</button>
            <button class="mini" data-pa="refresh" title="Rescan repos">⟳</button>`;
  }

  onAction(a: string) {
    if (a === "sort") {
      this.newestFirst = !this.newestFirst;
      this.render();
      return true;
    }
    if (a === "refresh") {
      void this.load(true);
      return true;
    }
    return false;
  }

  /** Called when the panel opens; rescans if the data is older than 30 s. */
  async load(force = false) {
    if (this.loading || (!force && Date.now() - this.loadedAt < 30_000)) {
      this.render();
      return;
    }
    this.loading = true;
    if (!this.repos.length) $("gitList").innerHTML = `<div class="none">Scanning repos…</div>`;
    try {
      this.repos = await invoke("git_repos", { roots: this.ctx.roots() });
      this.loadedAt = Date.now();
      for (const p of this.open) await this.loadCommits(p);
    } catch (e) {
      $("gitList").innerHTML = `<div class="none err">git scan failed: ${esc(e)}</div>`;
    } finally {
      this.loading = false;
    }
    this.render();
  }

  private async loadCommits(path: string) {
    try {
      this.commits.set(path, await invoke("git_log", { path, n: 25 }));
    } catch (e) {
      this.notes.set(path, { ok: false, text: String(e) });
    }
  }

  private async refreshOne(path: string) {
    const fresh: RepoInfo[] = await invoke("git_repos", { roots: [path] });
    if (fresh[0]) this.repos = this.repos.map((r) => (r.path === path ? fresh[0] : r));
    if (this.open.has(path)) await this.loadCommits(path);
  }

  render() {
    const el = $("gitList");
    const f = ($("gitFilter") as HTMLInputElement).value.trim().toLowerCase();
    const roots = this.ctx.roots();
    const sessions = this.ctx.sessions();
    const now = Date.now();
    const list = this.repos
      .filter((r) => !f || `${r.name} ${r.path} ${r.branch} ${r.last_commit?.subject ?? ""}`.toLowerCase().includes(f))
      .sort((a, b) => (this.newestFirst ? b.last_change_ms - a.last_change_ms : a.last_change_ms - b.last_change_ms));
    if (!list.length) {
      el.innerHTML = this.loading ? `<div class="none">Scanning repos…</div>` : `<div class="none">${f ? "No repo matches." : "No git repos found under your workspaces."}</div>`;
      return;
    }
    el.innerHTML = list.map((r) => {
      const inRepo = sessions.filter((s) => norm(s.cwd) === norm(r.path) || norm(s.cwd).startsWith(norm(r.path) + "\\"));
      const live = inRepo.some((s) => s.running);
      const isOpen = this.open.has(r.path);
      const sync = [
        r.ahead ? `<span class="ahead" title="${r.ahead} commit(s) to push">↑${r.ahead}</span>` : "",
        r.behind ? `<span class="behind" title="${r.behind} commit(s) to pull">↓${r.behind}</span>` : "",
        r.changes ? `<span class="dirty" title="${r.changes} changed file(s)">●${r.changes}</span>` : "",
      ].join("");
      const ws = basename(rootFor(r.path, roots));
      const head = `<div class="repo${isOpen ? " open" : ""}" data-repo="${esc(r.path)}" title="${esc(r.path)}">
          <span class="caret">${isOpen ? "▾" : "▸"}</span>
          <div class="txt">
            <div class="t">${live ? `<span class="live" title="a session is running here"></span>` : ""}${esc(r.name)} <span class="branch">${esc(r.detached ? "detached" : r.branch)}</span>${sync}</div>
            <div class="sub">${r.error ? `<span class="err">${esc(r.error)}</span>` : esc(r.last_commit ? r.last_commit.subject : "no commits yet")}${ws && ws !== r.name ? ` · ${esc(ws)}` : ""}</div>
          </div>
          <span class="when">${r.last_change_ms ? ago(r.last_change_ms, now) : ""}</span>
        </div>`;
      return head + (isOpen ? this.detail(r, inRepo, now) : "");
    }).join("");
  }

  private detail(r: RepoInfo, inRepo: Session[], now: number): string {
    const busy = this.busy.get(r.path);
    const dis = busy ? " disabled" : "";
    const note = this.notes.get(r.path);
    const commits = this.commits.get(r.path) ?? [];
    const headHash = r.last_commit?.hash;
    const bar = `<div class="gitbar">
        <button class="mini" data-act="fetch" data-path="${esc(r.path)}"${dis || (!r.has_remote ? " disabled" : "")}>Fetch</button>
        <button class="mini" data-act="pull" data-path="${esc(r.path)}"${dis || (!r.upstream ? " disabled" : "")} title="Fast-forward only - never merges">Pull${r.behind ? ` ↓${r.behind}` : ""}</button>
        <button class="mini" data-act="push" data-path="${esc(r.path)}"${dis || (!r.has_remote ? " disabled" : "")}>Push${r.ahead ? ` ↑${r.ahead}` : ""}</button>
        <button class="mini" data-act="session" data-path="${esc(r.path)}">＋ Session</button>
        ${busy ? `<span class="muted small">${esc(busy)}…</span>` : ""}
      </div>`;
    const msg = note ? `<div class="gitnote ${note.ok ? "ok" : "err"}">${esc(note.text)}</div>` : "";
    const sess = inRepo.length
      ? `<div class="gitsess">${inRepo.map((s) => `<span class="chip" data-sid="${esc(s.id)}" title="${esc(s.cwd)}"><span class="dot st-${s.status}"></span>${esc(s.name || s.autoTitle || "session")}</span>`).join("")}</div>`
      : "";
    const rows = commits.length
      ? commits.map((c) => {
          const canReword = c.hash === headHash && !c.pushed;
          return `<div class="commit${c.pushed ? "" : " local"}" title="${esc(c.hash)}\n${esc(c.author)}${c.body ? "\n\n" + esc(c.body) : ""}">
              <span class="hash">${esc(c.short)}</span>
              <div class="txt"><div class="t">${esc(c.subject)}</div><div class="sub">${esc(c.author)} · ${ago(c.time_ms, now)}${c.pushed ? "" : " · not pushed"}</div></div>
              ${canReword
                ? `<button class="mini" data-act="reword" data-path="${esc(r.path)}" data-hash="${esc(c.hash)}" title="Edit this commit message">Edit</button>`
                : c.hash === headHash ? `<span class="muted small" title="Already pushed - editing would need a force-push">pushed</span>` : ""}
            </div>`;
        }).join("")
      : `<div class="none small">loading commits…</div>`;
    return `<div class="repodetail">${bar}${msg}${sess}<div class="commits">${rows}</div></div>`;
  }

  private async onClick(e: Event) {
    const t = e.target as HTMLElement;
    const chip = t.closest<HTMLElement>("[data-sid]");
    if (chip) return this.ctx.select(chip.dataset.sid!);
    const act = t.closest<HTMLElement>("[data-act]");
    if (act) return this.act(act.dataset.act!, act.dataset.path!, act.dataset.hash);
    const head = t.closest<HTMLElement>("[data-repo]");
    if (head) {
      const p = head.dataset.repo!;
      if (this.open.has(p)) this.open.delete(p);
      else {
        this.open.add(p);
        this.render();
        await this.loadCommits(p);
      }
      this.render();
    }
  }

  private async act(action: string, path: string, hash?: string) {
    const r = this.repos.find((x) => x.path === path);
    if (!r) return;
    if (action === "session") return this.ctx.newSessionIn(path);
    if (action === "reword") {
      const c = (this.commits.get(path) ?? []).find((x) => x.hash === hash);
      if (!c) return;
      this.rewordTarget = { repo: path, commit: c };
      ($("rewordText") as HTMLTextAreaElement).value = c.body ? `${c.subject}\n\n${c.body}` : c.subject;
      $("rewordInfo").textContent = `${r.name} · ${c.short} · not pushed yet, so it is safe to change`;
      $("rewordErr").textContent = "";
      ($("dlgReword") as HTMLDialogElement).showModal();
      return;
    }
    if (action === "push") {
      const target = r.upstream ?? "origin (new upstream)";
      const ok = await this.ctx.confirm("Push?", `Push ${r.ahead || "the"} commit(s) on ${r.branch} in ${r.name} to ${target}?`);
      if (!ok) return;
    }
    this.busy.set(path, action);
    this.notes.delete(path);
    this.render();
    try {
      const out: string = await invoke("git_action", { path, action });
      const last = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? `${action} done`;
      this.notes.set(path, { ok: true, text: last });
      this.ctx.activity("git", `${action} ${r.name}: ${last}`, path);
    } catch (err) {
      this.notes.set(path, { ok: false, text: String(err) });
      this.ctx.activity("git-error", `${action} ${r.name} failed`, path);
    } finally {
      this.busy.delete(path);
      await this.refreshOne(path);
      this.render();
    }
  }

  private async saveReword() {
    const t = this.rewordTarget;
    if (!t) return;
    const message = ($("rewordText") as HTMLTextAreaElement).value;
    try {
      const short: string = await invoke("git_action", { path: t.repo, action: "reword", hash: t.commit.hash, message });
      ($("dlgReword") as HTMLDialogElement).close();
      this.notes.set(t.repo, { ok: true, text: `message updated (now ${short.trim()})` });
      this.ctx.activity("git", `reworded ${basename(t.repo)} ${t.commit.short} -> ${short.trim()}`, t.repo);
      await this.refreshOne(t.repo);
      this.render();
    } catch (err) {
      $("rewordErr").textContent = String(err);
    }
  }
}
