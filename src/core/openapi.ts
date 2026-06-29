import { OpenAPIHono } from "@hono/zod-openapi";
import { problemFromZod } from "./http.ts";

export function createApp() {
  return new OpenAPIHono({
    defaultHook: (result, c) => {
      // zod 검증 실패 → 422 problem+json(미디어타입 application/problem+json, finding #3 pass1/2)
      if (!result.success) {
        return c.json(problemFromZod(result.error), 422, {
          "content-type": "application/problem+json",
        });
      }
    },
  });
}

/** cookie session security scheme 등록(api-contract §1). 세션 쿠키는 __Host- prefix. */
export function registerSecurity(app: OpenAPIHono): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "cookieAuth", {
    type: "apiKey",
    in: "cookie",
    name: "__Host-better-auth.session_token",
  });
}
