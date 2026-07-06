import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../core/errors.ts";
import type { MembersService } from "../members/members.service.ts";
import type { TripRepo } from "./trips.repo.ts";
import type { CreateTrip, DeleteTripResult, TripResponse, UpdateTrip } from "./trips.schema.ts";
// CreateTripColumns는 repo가 받는 trip 컬럼 형태(admin_display_name 제외).

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

  /** trip 생성 + 생성자 어드민 멤버십을 **단일 tx**로(멤버십 실패 시 trip 롤백, finding #2 pass1). DB 제약 위반→422(finding #2 pass3).
   *  admin_display_name(§6.1)은 trips 컬럼이 아니라 생성자 멤버십 display_name으로 분리 전달(하드코딩 'Me' 대체). */
  async createTrip(input: CreateTrip, actor: TripActor): Promise<TripResponse> {
    const { admin_display_name, ...cols } = input;
    try {
      return await this.db.transaction(async (tx) => {
        const trip = await this.repo.create(cols, actor.id, tx);
        await this.members.ensureCreatorMembership(
          trip.id,
          actor.id,
          admin_display_name,
          actor.email,
          tx,
        );
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
  async updateTrip(id: string, patch: UpdateTrip): Promise<TripResponse> {
    let t: TripResponse | null;
    try {
      t = await this.repo.update(id, patch);
    } catch (e) {
      return asValidation(e);
    }
    if (!t) throw new NotFoundError("trip not found");
    return t;
  }

  /** 어드민 방 전체 삭제(무가드): 미들웨어 requireTripMember('admin')가 1차 게이팅, repo가 (내부 tx) trip 락 하 admin 재검증(F5·F7, TOCTOU 차단).
   *  finalized/paid여도 즉시 삭제, 자식은 FK cascade. repo.delete가 자체 tx를 열므로 서비스는 tx 관리 불필요. */
  async deleteTrip(tripId: string, callerMembershipId: string): Promise<DeleteTripResult> {
    const outcome = await this.repo.delete(tripId, callerMembershipId);
    if (outcome === "not_found") throw new NotFoundError("trip not found");
    if (outcome === "forbidden")
      throw new ForbiddenError("no longer an active admin of this trip", { tripId });
    return { id: tripId, deleted: true };
  }
}
