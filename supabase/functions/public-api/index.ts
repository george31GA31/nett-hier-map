import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import {
  ApiError,
  bounds,
  BUCKET,
  coordinates,
  MAX_PHOTO,
  photoPath,
  PUBLIC_FIELDS,
  report,
  sanitizeJpeg,
  sighting,
  uuid,
} from "./logic.ts";
const env = (name: string) => Deno.env.get(name) || "";
const origin = "https://george31ga31.github.io";
const service = createClient(
  env("SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const cors = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(status === 429 ? { "Retry-After": "60" } : {}),
    },
  });
async function rpc(name: string, args: Record<string, unknown> = {}) {
  const { data, error } = await service.rpc(name, args);
  if (error) throw error;
  return data;
}
async function userFor(req: Request, allowDeletion = false) {
  const token = (req.headers.get("Authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!token || token === env("SUPABASE_ANON_KEY")) return null;
  const { data, error } = await service.auth.getUser(token);
  if (error || !data.user || data.user.is_anonymous) {
    throw new ApiError(401, "Your session has expired. Please sign in again.");
  }
  if (
    !allowDeletion &&
    !await rpc("nh_account_allowed", { account_id: data.user.id })
  ) throw new ApiError(403, "This account is being deleted.");
  return data.user;
}
async function identity(req: Request) {
  const secret = env("ABUSE_HMAC_SECRET");
  if (secret.length < 32) {
    throw new ApiError(
      503,
      "Submissions are not ready yet. Please try again later.",
    );
  }
  // Quotas also have hard global caps, independent of headers, accounts and CAPTCHA.
  // Use the last hop appended by the trusted gateway; no client-chosen browser ID.
  const ip = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ||
    "unknown";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return [
    ...new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip)),
    ),
  ].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function captcha(token: unknown) {
  if (
    !env("TURNSTILE_SECRET_KEY") || typeof token !== "string" ||
    token.length > 2048
  ) {
    throw new ApiError(
      503,
      "Bot protection is unavailable. Please try again later.",
    );
  }
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      body: new URLSearchParams({
        secret: env("TURNSTILE_SECRET_KEY"),
        response: token,
      }),
      signal: AbortSignal.timeout(10000),
    },
  );
  const result = await response.json();
  if (
    !response.ok || !result.success ||
    result.hostname !== "george31ga31.github.io" ||
    result.action !== "submission"
  ) throw new ApiError(400, "Please complete the bot check again.");
}
async function cleanup() {
  const rows = await rpc("nh_cleanup_candidates");
  let removed = 0;
  for (const row of rows) {
    const path = photoPath(row.path);
    const { error } = await service.storage.from(BUCKET).remove([path]);
    await rpc("nh_cleanup_result", {
      photo: path,
      failure: error?.message || null,
    });
    if (!error) removed++;
  }
  return { removed, pending: rows.length - removed };
}
async function readBody(req: Request) {
  // Bound the actual stream, not just the client-controlled Content-Length.
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, "Empty request.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_PHOTO + 65536) {
      await reader.cancel();
      throw new ApiError(413, "Please choose a smaller photo.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  const ct = req.headers.get("Content-Type") || "";
  if (ct.startsWith("multipart/form-data")) {
    const f = await new Response(bytes, { headers: { "Content-Type": ct } })
      .formData();
    const raw = f.get("payload");
    if (typeof raw !== "string" || raw.length > 12000) {
      throw new ApiError(400, "Invalid submission.");
    }
    return { ...JSON.parse(raw), photo: f.get("photo") };
  }
  if (size > 16000) throw new ApiError(413, "Request too large.");
  return JSON.parse(new TextDecoder().decode(bytes));
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const body = await readBody(req);
    if (body.action === "config") {
      return json({
        turnstileSiteKey: env("TURNSTILE_SITE_KEY"),
        ready: !!env("TURNSTILE_SECRET_KEY") &&
          env("ABUSE_HMAC_SECRET").length >= 32,
      });
    }
    if (body.action === "stats") return json(await rpc("nh_stats"));
    if (body.action === "clusters") {
      const b = bounds(body);
      const z = Math.max(2, Math.min(18, Number(body.zoom) || 2));
      return json(await rpc("nh_clusters", { ...b, cell: 360 / 2 ** z / 5 }));
    }
    if (body.action === "map") {
      const b = bounds(body);
      return json(
        await rpc("nh_map_page", {
          ...b,
          after_id: body.after ? uuid(body.after) : null,
        }),
      );
    }
    if (body.action === "maintenance") {
      // Independent high-entropy secret; never accepted from a browser config file.
      const expected = env("OPERATIONS_TOKEN");
      if (
        expected.length < 32 ||
        req.headers.get("Authorization") !== `Bearer ${expected}`
      ) throw new ApiError(403, "Forbidden.");
      return json(await cleanup());
    }
    const user = await userFor(req, body.action === "delete-account");
    if (body.action === "moderator") {
      return json({
        moderator: !!user &&
          await rpc("nh_is_moderator", { account_id: user.id }),
      });
    }
    if (body.action === "moderate") {
      if (!user) throw new ApiError(403, "Owner access required.");
      if (!["list", "remove", "resolve", "pause"].includes(body.operation)) {
        throw new ApiError(400, "Invalid action.");
      }
      const result = await rpc("nh_moderation", {
        account_id: user.id,
        action: body.operation,
        target: body.target ? uuid(body.target) : null,
        paused: typeof body.paused === "boolean" ? body.paused : null,
      });
      if (body.operation === "remove") await cleanup();
      return json(result);
    }
    if (body.action === "delete-account") {
      if (!user || body.confirm !== "DELETE MY ACCOUNT") {
        throw new ApiError(400, "Confirm account deletion first.");
      }
      await rpc("nh_delete_account_data", { account_id: user.id });
      const token = (req.headers.get("Authorization") || "").replace(
        /^Bearer\s+/i,
        "",
      );
      await service.auth.admin.signOut(token, "global");
      const { error } = await service.auth.admin.deleteUser(user.id);
      if (error) throw error;
      await cleanup();
      return json({ ok: true });
    }
    if (body.action === "delete" || body.action === "edit") {
      if (!user) throw new ApiError(401, "Sign in to manage your sightings.");
      const id = uuid(body.id);
      let q;
      if (body.action === "delete") q = service.from("spots").delete();
      else {
        const s = sighting(body);
        q = service.from("spots").update({
          place: s.place,
          country: s.country,
          country_code: s.country_code,
          note: s.note,
          added_by: s.added_by,
          spotted_on: s.spotted_on,
        });
      }
      const { data, error } = await q.eq("id", id).eq("owner_id", user.id)
        .select(PUBLIC_FIELDS).maybeSingle();
      if (error) throw error;
      if (!data) {
        throw new ApiError(403, "You can only change your own sightings.");
      }
      if (body.action === "delete") await cleanup();
      return json(data);
    }
    if (!["sighting", "report", "geocode", "support"].includes(body.action)) {
      throw new ApiError(400, "Unknown action.");
    }
    const actor = await identity(req);
    if (body.action === "geocode") {
      const { lat, lng } = coordinates(body.lat, body.lng);
      await rpc("nh_reserve", {
        action: "geocode",
        actor,
        account_id: user?.id || null,
      });
      // Coarse cache cells deliberately cache the locality, never change the pin.
      const cache_key = `${lat.toFixed(2)},${lng.toFixed(2)}:en`;
      const lease = await rpc("nh_geocode_claim", { cache_key });
      if (lease.cached) return json(lease.cached);
      if (lease.busy) {
        throw new ApiError(
          429,
          "Location lookup is busy. Your exact coordinates can still be saved.",
        );
      }
      let result = null;
      try {
        const u = new URL("https://nominatim.openstreetmap.org/reverse");
        u.search = new URLSearchParams({
          format: "jsonv2",
          lat: String(lat),
          lon: String(lng),
          zoom: "10",
          addressdetails: "1",
          "accept-language": "en",
        }).toString();
        const r = await fetch(u, {
          headers: {
            "User-Agent":
              "NettHierMap/1.0 (https://george31ga31.github.io/nett-hier-map/)",
            "Referer": "https://george31ga31.github.io/nett-hier-map/",
          },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) {
          throw new ApiError(
            503,
            "Location name unavailable. Coordinates will be saved.",
          );
        }
        const v = await r.json();
        const a = v.address || {};
        const local = a.city || a.town || a.village || a.municipality ||
          a.county || a.state || "";
        result = {
          place: [local, a.country].filter(Boolean).join(", ").slice(0, 120),
          country: a.country || null,
          countryCode: (a.country_code || "").toUpperCase() || null,
        };
      } finally {
        await rpc("nh_geocode_finish", { cache_key, result });
      }
      return json(result);
    }
    await captcha(body.captchaToken);
    if (body.action === "support") {
      if (
        typeof body.message !== "string" || !body.message.trim() ||
        body.message.length > 2000 ||
        (body.reply_to &&
          (typeof body.reply_to !== "string" || body.reply_to.length > 254 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.reply_to)))
      ) throw new ApiError(400, "Please check your message and reply email.");
      await rpc("nh_reserve", {
        action: "report",
        actor,
        account_id: user?.id || null,
      });
      await rpc("nh_support", {
        spot_id: body.spot_id ? uuid(body.spot_id) : null,
        reply_to: body.reply_to || null,
        message: body.message.trim(),
      });
      return json({ ok: true });
    }
    if (body.action === "report") {
      const p = report(body);
      await rpc("nh_reserve", {
        action: "report",
        actor,
        account_id: user?.id || null,
      });
      const { data: spot, error: readError } = await service.from("spots")
        .select("id,owner_id").eq("id", p.spot_id).maybeSingle();
      if (readError) throw readError;
      if (!spot) throw new ApiError(404, "That sighting has been removed.");
      if (user && spot.owner_id === user.id) {
        throw new ApiError(400, "You cannot report your own sighting.");
      }
      const { error } = await service.from("spot_reports").insert({
        ...p,
        reporter_user_id: user?.id || null,
        reporter_token: user ? null : uuid(body.reporterToken),
      });
      if (error) throw error;
      return json({ ok: true });
    }
    const p = sighting(body);
    const requestId = uuid(body.requestId);
    const file = body.photo;
    if (!(file instanceof File) || file.type !== "image/jpeg") {
      throw new ApiError(400, "Please select a JPEG photo.");
    }
    const bytes = sanitizeJpeg(new Uint8Array(await file.arrayBuffer()));
    await rpc("nh_reserve", {
      action: "sighting",
      actor,
      account_id: user?.id || null,
      upload_bytes: bytes.length,
    });
    const path = await rpc("nh_photo_reserve", {
      request_id: requestId,
      account_id: user?.id || null,
    });
    const { error: uploadError } = await service.storage.from(BUCKET).upload(
      path,
      bytes,
      { contentType: "image/jpeg", upsert: false, cacheControl: "86400" },
    );
    if (uploadError) throw uploadError;
    try {
      return json(
        await rpc("nh_create_spot", {
          payload: p,
          path,
          account_id: user?.id || null,
        }),
      );
    } catch (e) {
      // Do not delete on an ambiguous DB timeout: the insert may have committed.
      // Managed pending uploads expire into the queue after an hour; the worker
      // rechecks references before removing anything.
      throw e;
    }
  } catch (e) {
    const failure = e as { message?: unknown; code?: string } | null;
    const message = String(failure?.message || "");
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    if (e instanceof SyntaxError) {
      return json({ error: "Invalid request." }, 400);
    }
    if (message.includes("QUOTA_EXCEEDED")) {
      return json({
        error: "The submission limit has been reached. Please try again later.",
      }, 429);
    }
    if (message.includes("SUBMISSIONS_PAUSED")) {
      return json({
        error:
          "New submissions are temporarily paused. Please try again later.",
      }, 503);
    }
    if (message.includes("STORAGE_BUDGET_REACHED")) {
      return json({
        error: "Photo storage is temporarily full. Please try again later.",
      }, 503);
    }
    if (message.includes("FORBIDDEN")) {
      return json({ error: "Owner access required." }, 403);
    }
    if (failure?.code === "23505") {
      return json({ error: "This submission has already been received." }, 409);
    }
    console.error("public-api request failed", {
      code: failure?.code,
      message: message.slice(0, 200),
    });
    return json({
      error: "We could not save that change. Please try again later.",
    }, 500);
  }
});
