// AWS Lambda entry (API Gateway HTTP API v2).
// Локально не используется — для локали см. local.ts.
import { route } from "./handlers.ts";

interface ApiGatewayEvent {
  requestContext?: { http?: { method?: string; path?: string } };
  rawPath?: string;
  rawQueryString?: string;
  queryStringParameters?: Record<string, string> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
}

export const handler = async (event: ApiGatewayEvent) => {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "/";
  const query: Record<string, string> = {};
  if (event.queryStringParameters) Object.assign(query, event.queryStringParameters);
  else if (event.rawQueryString) {
    for (const part of event.rawQueryString.split("&")) {
      const [k, v] = part.split("=");
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
    }
  }
  let body: unknown;
  if (event.body) {
    try {
      const text = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body;
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  const res = await route({ method, path, query, body });
  return {
    statusCode: res.status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    body: JSON.stringify(res.body),
  };
};
