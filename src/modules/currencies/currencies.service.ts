import type { CurrencyRepo, CurrencyRow } from "./currencies.repo.ts";

/** 통화 참조 데이터 서비스 — repo에 위임하는 얇은 계층(MembersService.listMembers 미러). */
export class CurrenciesService {
  constructor(private readonly repo: CurrencyRepo) {}

  list(): Promise<CurrencyRow[]> {
    return this.repo.listAll();
  }
}
