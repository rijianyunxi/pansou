export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);

    // 获取 Worker 域名后面的目标 URL
    let rawTarget = requestUrl.pathname.slice(1);

    // 未传 URL，返回全屏居中的 404 HTML
    if (!rawTarget) {
      return new Response(
        `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404</title>
  <style>
    * {
      box-sizing: border-box;
    }

    html,
    body {
      width: 100vw;
      height: 100vh;
      margin: 0;
      overflow: hidden;
    }

    body {
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f5f6f8;
      font-family: Arial, Helvetica, sans-serif;
    }

    .error {
      text-align: center;
      color: #333;
    }

    .error h1 {
      margin: 0;
      font-size: 96px;
      line-height: 1;
      font-weight: 700;
    }

    .error p {
      margin: 18px 0 0;
      color: #888;
      font-size: 16px;
    }
  </style>
</head>
<body>
  <div class="error">
    <h1>404</h1>
    <p>未找到要代理的网址</p>
  </div>
</body>
</html>`,
        {
          status: 404,
          headers: {
            "Content-Type": "text/html; charset=UTF-8",
          },
        }
      );
    }

    try {
      // 支持未编码和 URL 编码的目标地址
      rawTarget = decodeURIComponent(rawTarget);

      const target = new URL(rawTarget);

      // 只允许 HTTP 和 HTTPS
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        return new Response("只支持 HTTP 或 HTTPS URL", {
          status: 400,
          headers: {
            "Content-Type": "text/plain; charset=UTF-8",
          },
        });
      }

      // 将 Worker 请求后的查询参数传给源网站
      for (const [key, value] of requestUrl.searchParams.entries()) {
        target.searchParams.append(key, value);
      }

      // 仅代理来源运行时使用的 GET/HEAD/POST 请求
      if (!["GET", "HEAD", "POST"].includes(request.method)) {
        return new Response("只支持 GET、HEAD 和 POST 请求", {
          status: 405,
          headers: {
            Allow: "GET, HEAD, POST",
            "Content-Type": "text/plain; charset=UTF-8",
          },
        });
      }

      const upstreamHeaders = new Headers({
        "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
        Accept: request.headers.get("Accept") || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": request.headers.get("Accept-Language") || "zh-CN,zh;q=0.9,en;q=0.8",
      });
      for (const name of ["content-type", "content-length", "authorization"]) {
        const value = request.headers.get(name);
        if (value) upstreamHeaders.set(name, value);
      }

      // 请求源网站
      const upstream = await fetch(target.toString(), {
        method: request.method,
        headers: upstreamHeaders,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });

      // 源网站响应原样返回
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } catch (error) {
      return new Response(
        `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>代理错误</title>
</head>
<body>
  <h1>代理请求失败</h1>
  <p>${escapeHtml(error.message || "目标 URL 无效")}</p>
</body>
</html>`,
        {
          status: 502,
          headers: {
            "Content-Type": "text/html; charset=UTF-8",
          },
        }
      );
    }
  },
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };

    return map[char];
  });
}
