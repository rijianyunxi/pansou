export interface HotSearchItem { term: string; normalizedTerm: string; score: number; lastSearched: number; createdAt: number; status: "approved" | "pending" | "blocked" | "hidden"; source: "auto" | "manual"; pinned: boolean; manualWeight: number; updatedAt: number; }
export type HotSearchStatus = HotSearchItem["status"];
