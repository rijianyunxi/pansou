import { createError } from "h3";

export function positiveInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw createError({ statusCode: 400, statusMessage: `invalid ${name}` });
  return parsed;
}