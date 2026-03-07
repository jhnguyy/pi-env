export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
  addedAt: string;      // ISO timestamp
  completedAt?: string;
}
