import type { MiddlewareHandler } from "hono";

/** 응답 Set-Cookie 이름을 __Host- 로 강제(Domain 제거·Secure·Path=/). BA의 __Secure- prepend를 무력화(finding #1 pass5).
 *  secure=false(로컬 http)면 __Host-(Secure 요구) 불가 → 그대로 둔다. */
export function enforceHostCookie(opts: { secure: boolean }): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (!opts.secure) return;
    const cookies = c.res.headers.getSetCookie();
    if (cookies.length === 0) return;
    const fixed = cookies.map((raw) => {
      const eq = raw.indexOf("=");
      if (eq < 0) return raw;
      const bareName = raw
        .slice(0, eq)
        .replace(/^__Secure-/i, "")
        .replace(/^__Host-/i, "");
      let attrs = raw.slice(eq).replace(/;\s*Domain=[^;]*/i, ""); // "=value; attrs" 에서 Domain 제거
      if (!/;\s*Secure/i.test(attrs)) attrs += "; Secure";
      attrs = /;\s*Path=/i.test(attrs)
        ? attrs.replace(/;\s*Path=[^;]*/i, "; Path=/")
        : attrs + "; Path=/";
      return `__Host-${bareName}${attrs}`;
    });
    c.res.headers.delete("set-cookie");
    for (const sc of fixed) c.res.headers.append("set-cookie", sc);
  };
}
