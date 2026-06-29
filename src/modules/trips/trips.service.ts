import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import type { MembersService } from "../members/members.service.ts";
import type { TripRepo } from "./trips.repo.ts";
import type { CreateTrip, TripResponse } from "./trips.schema.ts";

export interface TripActor {
  id: string;
  email: string;
}

// drizzle은 postgres 에러를 감싸므로 SQLSTATE는 .code 또는 .cause.code. 23503(FK 미지 통화)·23514(check 역순날짜)는 입력 오류.
const dbCode = (e: unknown): string | undefined =>
  (e as { code?: string } | null)?.code ?? (e as { cause?: { code?: string } } | null)?.cause?.code;
const asValidation = (e: unknown): never => {
  const c = dbCode(e);
  if (c === "23503" || c === "23514")
    throw new ValidationError("invalid trip input (currency or dates)", { sqlstate: c });
  throw e;
};

export class TripsService<T extends Record<string, unknown>> {
  constructor(
    private readonly db: PostgresJsDatabase<T>,
    private readonly repo: TripRepo,
    private readonly members: MembersService,
  ) {}

  /** trip 생성 + 생성자 어드민 멤버십을 **단일 tx**로(멤버십 실패 시 trip 롤백, finding #2 pass1). DB 제약 위반→422(finding #2 pass3). */
  async createTrip(input: CreateTrip, actor: TripActor): Promise<TripResponse> {
    try {
      return await this.db.transaction(async (tx) => {
        const trip = await this.repo.create(input, actor.id, tx);
        await this.members.ensureCreatorMembership(trip.id, actor.id, "Me", actor.email, tx);
        return trip;
      });
    } catch (e) {
      return asValidation(e);
    }
  }
  async listTrips(userId: string): Promise<TripResponse[]> {
    return this.repo.listForUser(userId);
  }
  /** 멤버만 조회(인가는 미들웨어 requireTripMember가 1차, 여기선 존재 확인). */
  async getTrip(id: string): Promise<TripResponse> {
    const t = await this.repo.findById(id);
    if (!t) throw new NotFoundError("trip not found");
    return t;
  }
  /** 수정은 어드민(미들웨어 requireTripMember('admin')가 게이팅). DB 제약 위반→422. */
  async updateTrip(id: string, patch: Partial<CreateTrip>): Promise<TripResponse> {
    let t: TripResponse | null;
    try {
      t = await this.repo.update(id, patch);
    } catch (e) {
      return asValidation(e);
    }
    if (!t) throw new NotFoundError("trip not found");
    return t;
  }
}
