/**
 * 请求/响应适配层：把 express 的 req/res 包装成 worker 里的 Fetch 形状。
 *
 * 目的仍是"让业务代码原样搬"。worker 里每个接口的签名是
 * `(request, env, url)`，其中 request 只用到三样东西：
 *   request.method / request.headers.get(name) / request.json()
 * 响应那边只用 `new Response(body, { status, headers })`。
 *
 * 于是这里提供一个最小实现，不引入 undici 的流式请求构造 —— 那套在
 * express 后面反而更容易出错（body 已经被读过了）。
 */

/** worker 里 `accountJson` 的返回物：只是一个三字段的袋子。 */
export class JsonResponse {
  constructor(body, { status = 200, headers = {} } = {}) {
    this.body = body;
    this.status = status;
    this.headers = headers;
  }
}

/** 把 express req 包成 worker 风格的 request。 */
export function wrapRequest(req, baseOrigin) {
  const url = new URL(req.originalUrl ?? req.url, baseOrigin || `http://${req.headers.host ?? "localhost"}`);
  return {
    method: req.method,
    url: url.toString(),
    headers: {
      get(name) {
        const value = req.headers[String(name).toLowerCase()];
        if (value === undefined) return null;
        return Array.isArray(value) ? value.join(",") : String(value);
      },
    },
    /**
     * body 已经由 express.json() 解好。
     * 没有 body 时返回 null —— 与 `await request.json().catch(() => null)` 对齐，
     * 因为不少接口靠 `if (!body || typeof body !== "object")` 判空。
     */
    async json() {
      return req.body && typeof req.body === "object" ? req.body : null;
    },
  };
}

/**
 * CORS：与 worker 完全一致的口径 —— 带 cookie 的跨域不能回 `*`，必须回显 Origin。
 *
 * 同源部署（主站与接口同一个域名）时浏览器根本不带 Origin，
 * 这里什么都不加，也避免被误判成宽松策略。
 */
export function corsHeaders(origin) {
  const headers = {
    /*
     * ⚠️ 这里**不能**设 Content-Type。
     *
     * 早先这里写了 `application/json`，结果后台三个页面的 HTML 被当成 JSON 返回，
     * 浏览器直接把 `<DOCTYPE html>...` 显示成纯文本（截图才看出来）。
     * 类型应该由各自的响应决定：res.json() 自己会设 json，
     * res.send(html) 自己会设 text/html。
     */
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

/** 把 JsonResponse 写回 express res。 */
export function sendJsonResponse(res, payload) {
  const headers = payload.headers ?? {};
  for (const [key, value] of Object.entries(headers)) {
    if (key === "Set-Cookie") {
      const list = Array.isArray(value) ? value : [value];
      res.setHeader("Set-Cookie", list);
      continue;
    }
    res.setHeader(key, value);
  }
  res.status(payload.status ?? 200);
  if (payload.body === undefined || payload.body === null) {
    res.end();
    return;
  }
  res.send(typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body));
}
