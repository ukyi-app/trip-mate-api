import { z } from "@hono/zod-openapi";
import { displayName } from "../../core/schema.ts";

export const memberResponseSchema = z
  .object({
    id: z.string(),
    display_name: z.string(),
    role: z.enum(["admin", "member"]),
    status: z.enum(["invited", "joined", "deactivated", "invite_expired"]),
  })
  .openapi("Member");

export const createInviteSchema = z
  .object({ email: z.string().email(), display_name: displayName })
  .openapi("CreateInvite");

export const updateMemberSchema = z
  .object({
    display_name: displayName.optional(),
    status: z.enum(["deactivated", "joined"]).optional(), // 비활성/복구. role(=admin 양도)은 후속 트랜잭션 액션(finding #4 pass1)
  })
  .openapi("UpdateMember");

export const acceptResponseSchema = z
  .object({ trip_id: z.string(), role: z.enum(["admin", "member"]), status: z.string() })
  .openapi("AcceptInvite");

export const inviteRevokedSchema = z
  .object({
    id: z.string(),
    status: z.enum(["invited", "joined", "deactivated", "invite_expired"]),
  })
  .openapi("InviteRevoked");

/** GET /v1/me/invites 응답 아이템 — user-scoped 초대 발견 표면.
 *  토큰/user_id/member id는 노출하지 않는다(수락은 이메일 링크의 raw 토큰으로만, 해시만 저장). */
export const myInviteSchema = z
  .object({
    trip_id: z.string().uuid(),
    trip_title: z.string(),
    role: z.enum(["admin", "member"]),
    invited_email: z.string(),
    expires_at: z.iso.datetime(),
  })
  .openapi("MyInvite");
