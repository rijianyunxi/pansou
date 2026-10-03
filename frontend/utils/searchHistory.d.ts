export function normalize(value: unknown): string[];
export function createHistory(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): {
  read(): string[];
  add(term: string): string[];
  remove(term: string): string[];
  clear(): string[];
};
