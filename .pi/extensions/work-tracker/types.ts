export interface WorkTrackerConfig {
  /** Repo paths to guard against direct pushes to protected branches */
  guardedRepos: string[];
  /** Branch names that cannot be pushed to directly */
  protectedBranches: string[];
}

export interface BranchGuardResult {
  shouldBlock: boolean;
  reason?: string;
  targetBranch?: string;
}
