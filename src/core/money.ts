import { SettlementInvariantError } from "./errors.ts";

type Brand<T, B> = T & { readonly __brand: B };
export type TripId = Brand<string, "TripId">;
export type MemberId = Brand<string, "MemberId">;
export type ExpenseId = Brand<string, "ExpenseId">;
export type CurrencyCode = Brand<string, "CurrencyCode">;
export type Minor = Brand<bigint, "Minor">;

export interface Money {
  readonly amount: Minor;
  readonly currency: CurrencyCode;
}

export const minor = (n: bigint): Minor => n as Minor;
export const money = (amount: bigint, currency: string): Money => ({
  amount: amount as Minor,
  currency: currency as CurrencyCode,
});

export const add = (a: Money, b: Money): Money => {
  if (a.currency !== b.currency) throw new SettlementInvariantError("currency mismatch in add");
  return { amount: (a.amount + b.amount) as Minor, currency: a.currency };
};
