/** starting: process launched, no hook yet
 *  idle:     ready for a prompt (SessionStart, or after you read a "done")
 *  working:  Claude is busy (prompt submitted / tools running)
 *  needs:    Claude is waiting on you (permission prompt / question)
 *  done:     Claude finished its turn
 *  exited:   the claude process ended
 *  suspended: known session, no process (e.g. after an app restart) - resumable
 */
export type Status = "starting" | "idle" | "working" | "needs" | "done" | "exited" | "suspended";

export interface Session {
  id: string; // = Claude's session id (we pass --session-id / --resume)
  name: string; // user-given name ("" = auto)
  autoTitle: string; // first prompt, if any
  cwd: string;
  createdAt: number;
  lastEvent: number;
  lastMsg: string;
  status: Status;
  unread: number;
  hasTranscript: boolean; // a prompt was sent, so --resume will find it
  external: boolean; // running in a plain terminal (reported by global hooks)
  running: boolean; // a PTY in this app is attached
  worktree?: string; // name of the git worktree Claude created for this session
  extraArgs?: string[]; // e.g. ["--worktree"], reused when the session is started again before it has a transcript
}

export interface PastSession {
  id: string;
  cwd: string;
  title: string;
  first_prompt: string;
  modified_ms: number;
  size: number;
}

export interface Settings {
  notifyDone: boolean;
  notifyNeeds: boolean;
}

export interface AppInfo {
  version: string;
  data_dir: string;
  exe: string;
  claude: string | null;
  hook_port: number | null;
  global_hooks: boolean;
  user_settings: string;
  startup_error: string | null;
  autostart_managed: boolean;
  log_file: string;
}

export interface Persisted {
  version: 1;
  roots: string[];
  sessions: Session[];
  activeId: string | null;
  settings: Settings;
  ui?: { panel: "active" | "all" | "git" | "roadmaps" | "activity" | "jobs" | "search"; collapsed: boolean; width: number; gitNewestFirst?: boolean };
}

/** Payload Claude Code hands to a hook, plus `cw_tab` added by our client. */
export interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  message?: string;
  notification_type?: string;
  tool_name?: string;
  transcript_path?: string;
  cw_tab?: string;
  [k: string]: unknown;
}
