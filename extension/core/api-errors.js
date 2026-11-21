export const CHATGPT_USAGE_LIMIT = "subscription_sharing_usage_limit_exceeded";

const recoveryByCode = new Map([
  [CHATGPT_USAGE_LIMIT, "OpenAI reported a ChatGPT usage limit for this app. Check your plan allowance, app limit, and credit-use settings."],
  ["subscription_sharing_usage_unavailable", "OpenAI could not check your ChatGPT usage. Try again later."],
]);

export function apiError(response, payload, credential, fallback = "OpenAI ended the response without giving a reason.") {
  function field(value, limit) {
    if (typeof value !== "string" && !Number.isFinite(value)) return "";
    const text = String(value).trim();
    return (credential ? text.replaceAll(credential, "[redacted]") : text).slice(0, limit);
  }
  const detail = payload?.response?.error ?? payload?.error ?? payload?.detail ?? payload;
  const scalar = field(detail, 700);
  const explicitCode = field(detail?.code, 96) || field(payload?.code, 96) || field(detail?.error_code ?? payload?.error_code, 96)
    || (Number.isFinite(detail) || (payload?.error === detail && /^[\w.-]{1,96}$/.test(scalar)) ? scalar : "");
  const type = field(detail?.type, 96);
  const typeCode = ["error", "response.failed", "response.incomplete"].includes(type) ? "" : type;
  const code = (!explicitCode || /^-?\d+$/.test(explicitCode) ? typeCode : "") || explicitCode;
  const validation = Array.isArray(detail) ? detail.slice(0, 4)
    .map(item => field(item?.msg ?? item?.message, 160)).filter(Boolean).join(" ") : "";
  const description = field(detail?.message, 700) || field(payload?.message, 700) || field(payload?.error_description, 700)
    || field(detail?.msg, 700) || field(payload?.detail, 700) || validation || (scalar !== explicitCode ? scalar : "");
  const param = field(detail?.param, 96);
  const requestID = field(response.headers.get("x-request-id") || payload?.request_id || detail?.request_id, 128);
  const responseID = field(payload?.response?.id, 128);
  const eventStatus = field(payload?.status ?? detail?.status ?? payload?.status_code ?? detail?.status_code, 96);
  const streamStatus = /^\d{3}$/.test(eventStatus) ? `Status ${eventStatus}` : "";
  const status = response.ok ? streamStatus : `HTTP ${response.status}`;
  const explanation = [description, recoveryByCode.get(code)].filter(Boolean).join(" ");
  const statusSummary = response.ok ? status : [status, field(response.statusText, 96)].filter(Boolean).join(" ");
  const summary = explanation || (code && `OpenAI error ${code}.`) || statusSummary || fallback;
  const diagnostics = [explanation && code, explicitCode !== code && explicitCode, (explanation || code) && status, param && `parameter ${param}`,
    requestID ? `Request ${requestID}` : responseID && `Response ${responseID}`].filter(Boolean);
  const suffix = diagnostics.length ? ` (${diagnostics.join(", ")})` : "";
  const error = new Error(summary.slice(0, 1000 - suffix.length) + suffix);
  if (code) error.providerCode = code;
  return error;
}

export async function readAPIError(response, credential, fallback) {
  const body = await response.text();
  let payload;
  try { payload = JSON.parse(body); }
  catch {
    if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "text/plain" && !body.trimStart().startsWith("<")) payload = body;
  }
  return apiError(response, payload, credential, fallback);
}
