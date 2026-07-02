import { z } from "@hono/zod-openapi";

export const memberResponseSchema = z
  .object({
    id: z.string(),
    display_name: z.string(),
    role: z.enum(["admin", "member"]),
    status: z.enum(["invited", "joined", "deactivated", "invite_expired"]),
  })
  .openapi("Member");

export const createInviteSchema = z
  .object({ email: z.string().email(), display_name: z.string().min(1).max(60) })
  .openapi("CreateInvite");

export const updateMemberSchema = z
  .object({
    display_name: z.string().min(1).max(60).optional(),
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
