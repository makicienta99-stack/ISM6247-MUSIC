// Single Netlify Function that proxies the browser to SunoAPI.org.
// The API key lives only in the Netlify environment variable SUNO_API_KEY,
// so it is never exposed to visitors.
//
// Routes (all under /api/*):
//   GET  /api/credits                 -> remaining credits
//   POST /api/generate                -> start a music generation task
//   GET  /api/status?taskId=...       -> music task status + tracks
//   POST /api/lyrics                  -> start a lyrics generation task
//   GET  /api/lyrics-status?taskId=.. -> lyrics task status + text
//   POST /api/callback                -> receiver for SunoAPI callbacks (ack only)

const SUNO_BASE = "https://api.sunoapi.org";

const MODELS = ["V6", "V6_MINI", "V6_WILD", "V5_5", "V5", "V4_5PLUS", "V4_5ALL", "V4_5", "V4"];

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function callbackUrl(req) {
  // Netlify sets URL to the site's primary URL in production.
  const base = process.env.URL || new URL(req.url).origin;
  return `${base.replace(/\/$/, "")}/api/callback`;
}

async function suno(path, { method = "GET", body } = {}) {
  const key = process.env.SUNO_API_KEY;
  if (!key) {
    return { ok: false, status: 500, data: { msg: "Server is missing SUNO_API_KEY. Add it in Netlify → Site configuration → Environment variables." } };
  }
  const res = await fetch(`${SUNO_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { code: res.status, msg: `Unexpected response from SunoAPI (${res.status})` };
  }
  // SunoAPI returns HTTP 200 with its own `code` field; treat non-200 codes as errors.
  const ok = res.ok && (data.code === undefined || data.code === 200);
  return { ok, status: ok ? 200 : res.ok ? 502 : res.status, data };
}

function buildGeneratePayload(input, req) {
  const model = MODELS.includes(input.model) ? input.model : "V6";
  const customMode = Boolean(input.customMode);
  const instrumental = Boolean(input.instrumental);
  const payload = { customMode, instrumental, model, callBackUrl: callbackUrl(req) };

  if (!customMode) {
    // Simple mode: a description; Suno writes the lyrics.
    const prompt = str(input.prompt, 3000);
    const style = str(input.style, 1000);
    if (!prompt && !style) throw new Error("Describe the song you want.");
    if (prompt) payload.prompt = prompt;
    if (style) payload.style = style;
    return payload;
  }

  // Custom mode: user controls title, style and lyrics.
  const title = str(input.title, 80);
  const style = str(input.style, 1000);
  const lyrics = str(input.lyrics, 5000);
  const negativeTags = str(input.negativeTags, 1000);
  if (!style && !lyrics && !negativeTags) throw new Error("Add a style or lyrics.");
  if (!instrumental && !lyrics) throw new Error("Add lyrics, or switch on Instrumental.");
  if (title) payload.title = title;
  if (style) payload.style = style;
  if (lyrics && !instrumental) payload.lyrics = lyrics;
  if (negativeTags) payload.negativeTags = negativeTags;
  if (!instrumental && (input.vocalGender === "m" || input.vocalGender === "f")) {
    payload.vocalGender = input.vocalGender;
  }
  for (const k of ["styleWeight", "weirdnessConstraint"]) {
    const n = Number(input[k]);
    if (input[k] !== undefined && input[k] !== "" && Number.isFinite(n)) {
      payload[k] = Math.min(1, Math.max(0, n));
    }
  }
  return payload;
}

// Normalise track fields (the API uses both snake_case and camelCase).
function normaliseTracks(list) {
  if (!Array.isArray(list)) return [];
  return list.map((t) => ({
    id: t.id,
    title: t.title || "Untitled",
    tags: t.tags || "",
    duration: t.duration || null,
    prompt: t.prompt || "",
    imageUrl: t.image_url || t.imageUrl || t.source_image_url || t.sourceImageUrl || "",
    audioUrl: t.audio_url || t.audioUrl || t.source_audio_url || t.sourceAudioUrl || "",
    streamUrl:
      t.stream_audio_url || t.streamAudioUrl || t.source_stream_audio_url || t.sourceStreamAudioUrl || "",
    createTime: t.createTime || t.create_time || "",
  }));
}

function checkPassword(req) {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return true;
  return req.headers.get("x-app-password") === pw;
}

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");

  try {
    if (route === "callback") {
      // SunoAPI requires a callback URL; the app polls for results, so just acknowledge.
      return json(200, { code: 200, msg: "received" });
    }

    if (route === "config" && req.method === "GET") {
      return json(200, { passwordRequired: Boolean(process.env.APP_PASSWORD) });
    }

    if (!checkPassword(req)) {
      return json(401, { msg: "Wrong or missing access password." });
    }

    if (route === "credits" && req.method === "GET") {
      const r = await suno("/api/v1/generate/credit");
      return json(r.status, r.ok ? { credits: r.data.data } : { msg: r.data.msg });
    }

    if (route === "generate" && req.method === "POST") {
      let payload;
      try {
        payload = buildGeneratePayload(await req.json(), req);
      } catch (e) {
        return json(400, { msg: e.message || "Invalid request" });
      }
      const r = await suno("/api/v1/generate", { method: "POST", body: payload });
      return json(r.status, r.ok ? { taskId: r.data.data?.taskId } : { msg: r.data.msg, code: r.data.code });
    }

    if (route === "status" && req.method === "GET") {
      const taskId = url.searchParams.get("taskId");
      if (!taskId) return json(400, { msg: "taskId is required" });
      const r = await suno(`/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`);
      if (!r.ok) return json(r.status, { msg: r.data.msg, code: r.data.code });
      const d = r.data.data || {};
      return json(200, {
        taskId: d.taskId || taskId,
        status: d.status || "PENDING",
        errorMessage: d.errorMessage || null,
        tracks: normaliseTracks(d.response?.sunoData || d.response?.data),
      });
    }

    if (route === "lyrics" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const prompt = str(body.prompt, 200);
      if (!prompt) return json(400, { msg: "Describe what the lyrics should be about." });
      const r = await suno("/api/v1/lyrics", {
        method: "POST",
        body: { prompt, callBackUrl: callbackUrl(req) },
      });
      return json(r.status, r.ok ? { taskId: r.data.data?.taskId } : { msg: r.data.msg, code: r.data.code });
    }

    if (route === "lyrics-status" && req.method === "GET") {
      const taskId = url.searchParams.get("taskId");
      if (!taskId) return json(400, { msg: "taskId is required" });
      const r = await suno(`/api/v1/lyrics/record-info?taskId=${encodeURIComponent(taskId)}`);
      if (!r.ok) return json(r.status, { msg: r.data.msg, code: r.data.code });
      const d = r.data.data || {};
      const items = (d.response?.data || []).map((x) => ({ title: x.title || "", text: x.text || "" }));
      return json(200, { status: d.status || "PENDING", errorMessage: d.errorMessage || null, lyrics: items });
    }

    return json(404, { msg: "Not found" });
  } catch (err) {
    console.error(err);
    return json(500, { msg: "Something went wrong talking to SunoAPI. Please try again." });
  }
};

export const config = { path: "/api/*" };
