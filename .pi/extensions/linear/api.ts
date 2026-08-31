export interface LinearIdentity {
  organization: { id: string; name: string; urlKey: string };
  viewer: { id: string; name: string; displayName: string; email: string };
}

export interface ViewerSummary extends LinearIdentity {}

export interface IssueSummary {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  priority: number;
  priorityLabel: string;
  state?: { id: string; name: string };
  assignee?: { id: string; name: string };
  teamId?: string;
  updatedAt: string;
  url: string;
}

export interface CommentSummary {
  id: string;
  issueId?: string;
  createdAt: string;
  url: string;
}

export const LinearResourceType = {
  Teams: "teams",
  Users: "users",
  States: "states",
  Projects: "projects",
  Labels: "labels",
} as const;

export type LinearResourceType = (typeof LinearResourceType)[keyof typeof LinearResourceType];

export interface LinearResourceSummary {
  type: LinearResourceType;
  id: string;
  name: string;
  key?: string;
  email?: string;
  teamId?: string;
}

export interface CursorPage<T> {
  nodes: T[];
  hasMore: boolean;
  endCursor?: string;
  totalCount?: number;
}

export interface IssuePageInput {
  limit: number;
  cursor?: string;
  includeArchived?: boolean;
  teamId?: string;
  assigneeId?: string;
}

export interface SearchIssuePageInput extends IssuePageInput {
  query: string;
}

export interface ResourcePageInput {
  type: LinearResourceType;
  limit: number;
  cursor?: string;
  query?: string;
  teamId?: string;
}

export interface CreateIssueApiInput {
  id: string;
  teamId: string;
  title: string;
  description?: string;
  assigneeId?: string;
  stateId?: string;
  projectId?: string;
  priority?: number;
  dueDate?: string;
  labelIds?: string[];
}

export interface UpdateIssueApiInput {
  issueId: string;
  title?: string;
  description?: string;
  assigneeId?: string | null;
  stateId?: string;
  projectId?: string | null;
  priority?: number;
  dueDate?: string | null;
  labelIds?: string[];
}

export interface CreateCommentApiInput {
  id: string;
  issueId: string;
  body: string;
}

export interface LinearApi {
  identity(): Promise<LinearIdentity>;
  viewer(): Promise<ViewerSummary>;
  listIssues(input: IssuePageInput): Promise<CursorPage<IssueSummary>>;
  searchIssues(input: SearchIssuePageInput): Promise<CursorPage<IssueSummary>>;
  issue(issueId: string): Promise<IssueSummary>;
  resources(input: ResourcePageInput): Promise<CursorPage<LinearResourceSummary>>;
  createIssue(input: CreateIssueApiInput): Promise<IssueSummary>;
  updateIssue(input: UpdateIssueApiInput): Promise<IssueSummary>;
  createComment(input: CreateCommentApiInput): Promise<CommentSummary>;
}

export type LinearApiFactory = (apiKey: string, signal?: AbortSignal) => LinearApi;
