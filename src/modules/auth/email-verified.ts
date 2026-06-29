import { ForbiddenError } from "../../core/errors.ts";

export interface GoogleProfileLike {
  email: string;
  email_verified?: boolean;
}

/** Google profile의 email_verified=true만 허용. 아니면 ForbiddenError(초대 매칭·로그인 차단, §34.4). */
export function assertGoogleEmailVerified<T extends GoogleProfileLike>(profile: T): T {
  if (profile.email_verified !== true) {
    throw new ForbiddenError("google email not verified", { email: profile.email });
  }
  return profile;
}
