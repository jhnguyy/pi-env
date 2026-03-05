export interface WorkTrackerConfig {
  /** Repo paths to guard against direct pushes to protected branches */
  guardedRepos: string[];
  /** Branch names that cannot be pushed to directly */
  protectedBranches: string[];
  /** Path to work state JSON file */
  workStatePath: string;
  /** Directory for retrospective JSON files */
  retrospectivesDir: string;
}

export interface ActiveWork {
  sessionId: string;
  task: string;
  branch: string | null;
  repo: string | null;
  startedAt: string;
  filesTouched: string[];
}

export interface CompletedWork {
  task: string;
  branch: string | null;
  repo: string | null;
  outcome: "success" | "partial" | "abandoned";
  completedAt: string;
  durationMinutes: number;
  summary: string;
  filesChanged: string[];
}

export interface WorkState {
  active: ActiveWork | null;
  recent: CompletedWork[];
}

export interface Retrospective {
  sessionId: string;
  task: string;
  branch: string | null;
  repo: string | null;
  outcome: "success" | "partial" | "abandoned";
  startedAt: string;
  completedAt: string;
  durationMinutes: number;
  filesChanged: string[];
  notes: string;
}

export interface BranchGuardResult {
  shouldBlock: boolean;
  reason?: string;
  targetBranch?: string;
}
