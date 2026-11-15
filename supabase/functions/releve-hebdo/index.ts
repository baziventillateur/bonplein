import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Relevé hebdomadaire des prix des carburants (flux officiel), recalcul des KPI,
// puis envoi du « point du lundi » aux abonnés (si RESEND_API_KEY est défini).
// Appelée une fois par semaine par pg_cron. Protégée par un secret (en-tête x-cron-secret).

const EXPORT = "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/exports/json";
const FUELS = ["gazole", "e10", "sp95", "sp98", "e85", "gplc"] as const;
const FUEL_NAME: Record<string, string> = { gazole: "Gazole", e10: "SP95-E10", sp95: "SP95", sp98: "SP98", e85: "E85", gplc: "GPL" };
const MAX_AGE_DAYS = 45;
const SITE = "https://bonplein.paceapp.fr/";
const MAX_MAILS = 300;

type St = { id: number; adresse: string; ville: string; lat: number | null; lon: number | null; p: Record<string, number | null> };

function mondayParis(): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const d = new Date(p + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function price(v: unknown): number | null {
  if (v == null || v === "") return null;
  let n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  if (!isFinite(n)) return null;
  if (n > 100) n /= 1000;
  if (n < 0.3 || n > 4) return null;
  return Math.round(n * 1000);
}
function coord(r: Record<string, unknown>, k: "lat" | "lon"): number | null {
  const g = r.geom as Record<string, unknown> | null;
  let v = g && typeof g === "object" ? Number(g[k]) : NaN;
  if (!isFinite(v)) { v = Number(r[k === "lat" ? "latitude" : "longitude"]); if (isFinite(v) && Math.abs(v) > 180) v /= 100000; }
  return isFinite(v) ? v : null;
}
function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371, rad = (x: number) => x * Math.PI / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const eur = (m: number) => (m / 1000).toFixed(3).replace(".", ",") + " €";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
function nice(s: unknown): string {
  const t = String(s ?? "").trim().replace(/\s+/g, " ");
  if (!t || t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s\-'’])([a-zà-ÿ])/g, (_m, p, c) => p + c.toUpperCase());
}
// Version texte d'un bloc HTML (les messageries notent mieux un e-mail qui a aussi une version texte).
function toText(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|tr|div|h\d)>/gi, "\n").replace(/<\/td>/gi, "  ")
    .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

Deno.serve(async (req: Request) => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const { data: ok, error: e0 } = await db.rpc("cron_secret_ok", { s: req.headers.get("x-cron-secret") ?? "" });
  if (e0) return json({ error: "auth", detail: e0.message }, 500);
  if (!ok) return json({ error: "forbidden" }, 403);

  const select = "id,cp,pop,adresse,ville,geom," + FUELS.map((f) => `${f}_prix,${f}_maj`).join(",");
  let res = await fetch(EXPORT + "?select=" + encodeURIComponent(select));
  let mode = "select";
  if (!res.ok) { res = await fetch(EXPORT); mode = "full"; }
  if (!res.ok) return json({ error: "source", status: res.status }, 502);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length < 1000) return json({ error: "source_incomplete", count: Array.isArray(rows) ? rows.length : null }, 502);

  const semaine = mondayParis();
  const limit = Date.now() - MAX_AGE_DAYS * 864e5;
  const byId = new Map<number, St>();
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const id = Number(r.id);
    if (!Number.isSafeInteger(id) || byId.has(id)) continue;
    const rec: Record<string, unknown> = { station_id: id, semaine };
    const p: Record<string, number | null> = {};
    let any = false;
    for (const f of FUELS) {
      const v = price(r[f + "_prix"]);
      const maj = r[f + "_maj"] ? Date.parse(String(r[f + "_maj"])) : NaN;
      const fresh = v != null && isFinite(maj) && maj >= limit;
      rec[f] = p[f] = fresh ? v : null;
      if (fresh) any = true;
    }
    if (!any) continue;
    const cp = String(r.cp ?? "");
    rec.metro = !(String(r.pop ?? "").toUpperCase() === "A" || /^9[78]/.test(cp));
    byId.set(id, { id, adresse: nice(r.adresse), ville: nice(r.ville), lat: coord(r, "lat"), lon: coord(r, "lon"), p });
    out.push(rec);
  }

  for (let i = 0; i < out.length; i += 1000) {
    const { error } = await db.from("releve").upsert(out.slice(i, i + 1000), { onConflict: "station_id,semaine" });
    if (error) return json({ error: "upsert", detail: error.message, at: i }, 500);
  }
  const { error: e2 } = await db.rpc("recalculer_kpi");
  if (e2) return json({ error: "kpi", detail: e2.message }, 500);

  let mails: Record<string, unknown> = { skipped: "no_key" };
  try { mails = await pointDuLundi(db, semaine, byId); } catch (e) { mails = { error: String((e as Error)?.message ?? e) }; }

  return json({ ok: true, semaine, mode, source: rows.length, stations: out.length, mails });
});

// deno-lint-ignore no-explicit-any
async function pointDuLundi(db: any, semaine: string, byId: Map<number, St>) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { skipped: "no_key" };
  const from = Deno.env.get("ALERT_FROM") ?? "Bonplein <bonplein@paceapp.fr>";
  // Les réponses des abonnés arrivent sur une boîte réellement relevée.
  const replyTo = Deno.env.get("ALERT_REPLY_TO") ?? "contact@paceapp.fr";
  // Désabonnement : bouton natif de la messagerie (POST en un clic) et lien en bas de l'e-mail (page de confirmation).
  const unsubApi = Deno.env.get("SUPABASE_URL") + "/functions/v1/desabonnement?t=";
  const { data: subs, error } = await db.rpc("abonnes_point", { p_semaine: semaine });
  if (error) throw new Error(error.message);
  if (!subs?.length) return { sent: 0 };

  // Prix de la semaine précédente pour les stations favorites
  const favIds = new Set<number>();
  for (const s of subs) for (const f of (Array.isArray(s.favoris) ? s.favoris : [])) { const id = Number(f?.id); if (Number.isSafeInteger(id)) favIds.add(id); }
  const prev = new Map<number, Record<string, number | null>>();
  if (favIds.size) {
    const { data: old } = await db.from("releve").select("station_id,semaine," + FUELS.join(","))
      .in("station_id", [...favIds]).lt("semaine", semaine).order("semaine", { ascending: false }).limit(favIds.size * 3);
    for (const o of old ?? []) if (!prev.has(o.station_id)) prev.set(o.station_id, o);
  }
  const all = [...byId.values()];
  let sent = 0, failed = 0;

  for (const s of subs.slice(0, MAX_MAILS)) {
    const a = s.alertes ?? {};
    const fuel = FUELS.includes(a.fuel) ? a.fuel as string : "gazole";
    const blocks: string[] = [];
    let subject = "Le point Bonplein du lundi";
    let preheader = "Les prix des carburants relevés ce lundi autour de chez vous.";

    const lat = Number(a.lat), lon = Number(a.lon), rayon = Math.min(50, Math.max(1, Number(a.rayon) || 5));
    if (isFinite(lat) && isFinite(lon)) {
      const near = all.filter((x) => x.p[fuel] != null && x.lat != null && x.lon != null && km({ lat, lon }, { lat: x.lat!, lon: x.lon! }) <= rayon)
        .sort((x, y) => x.p[fuel]! - y.p[fuel]!);
      if (near.length) {
        const b = near[0], avg = near.reduce((t, x) => t + x.p[fuel]!, 0) / near.length;
        const seuil = Number(a.seuil) > 0 ? Math.round(Number(a.seuil) * 1000) : null;
        const hit = seuil != null && b.p[fuel]! <= seuil;
        subject = FUEL_NAME[fuel] + " à " + eur(b.p[fuel]!) + " près de chez vous" + (hit ? " : sous votre seuil" : "");
        preheader = `${b.adresse}, ${b.ville} : la station la moins chère dans un rayon de ${rayon} km.`;
        blocks.push(
          `<p style="margin:0 0 4px;color:#5D6A74;font-size:14px">${esc(FUEL_NAME[fuel])} le moins cher, ${rayon} km autour de ${esc(a.label ?? "votre adresse")}</p>` +
          `<p style="margin:0;font-size:40px;font-weight:700;color:#1D2731">${eur(b.p[fuel]!)}<span style="font-size:15px;font-weight:400;color:#5D6A74"> le litre</span></p>` +
          `<p style="margin:4px 0 0;font-size:16px"><b>${esc(b.adresse)}</b>, ${esc(b.ville)}</p>` +
          (hit ? `<p style="margin:10px 0 0;font-size:15px;color:#0E8459"><b>Sous votre seuil de ${eur(seuil!)}.</b></p>` : "") +
          (near.length > 1 ? `<p style="margin:10px 0 0;font-size:14px;color:#5D6A74">${near.length} stations dans ce rayon, moyenne ${eur(Math.round(avg))}.</p>` : ""));
      }
    }

    const favs = (Array.isArray(s.favoris) ? s.favoris : []).slice(0, 12);
    const lines: string[] = [];
    for (const f of favs) {
      const st = byId.get(Number(f?.id));
      const now = st?.p[fuel];
      if (now == null) continue;
      const before = prev.get(Number(f.id))?.[fuel];
      const d = before != null ? now - before : null;
      const evo = d == null ? "" : d === 0 ? "stable" : (d > 0 ? `<span style="color:#B83C2A">+${eur(d)}</span>` : `<span style="color:#0E8459">−${eur(-d)}</span>`);
      lines.push(`<tr><td style="padding:6px 0;border-top:1px solid #D6DCDF">${esc(f.adresse ?? st!.adresse)}<br><span style="color:#5D6A74;font-size:13px">${esc(f.ville ?? st!.ville)}</span></td>` +
        `<td style="padding:6px 0;border-top:1px solid #D6DCDF;text-align:right;white-space:nowrap"><b>${eur(now)}</b><br><span style="font-size:13px">${evo}</span></td></tr>`);
    }
    if (lines.length) blocks.push(`<p style="margin:0 0 6px;font-weight:700">Vos stations (${esc(FUEL_NAME[fuel])})</p><table style="width:100%;border-collapse:collapse;font-size:15px">${lines.join("")}</table>`);
    if (!blocks.length) continue;

    const tok = String(s.desabo_token ?? "");
    const unsubPage = SITE + "?desabo=" + encodeURIComponent(tok);
    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>` +
      `<body style="margin:0;padding:0;background:#EEF1F2">` +
      `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#EEF1F2">${esc(preheader)}</div>` +
      `<div style="padding:24px 12px"><div style="font-family:Arial,Helvetica,sans-serif;color:#1D2731;max-width:520px;margin:0 auto;background:#FFFFFF;border-radius:8px;overflow:hidden">` +
      `<div style="background:#1D2731;color:#fff;padding:14px 18px;font-size:22px;font-weight:700;border-bottom:4px solid #F4C542">Bonplein</div>` +
      blocks.map((b) => `<div style="padding:16px 18px">${b}</div>`).join(`<div style="border-top:1px solid #D6DCDF"></div>`) +
      `<div style="padding:0 18px 18px"><a href="${SITE}" style="display:inline-block;background:#F4C542;color:#1D2731;font-weight:700;text-decoration:none;padding:11px 16px;border-radius:6px">Voir les prix en direct</a></div>` +
      `<div style="padding:14px 18px 18px;border-top:1px solid #D6DCDF;font-size:12px;line-height:1.5;color:#5D6A74">` +
      `<p style="margin:0 0 6px">Prix relevés ce lundi dans le flux officiel prix-carburants.gouv.fr.</p>` +
      `<p style="margin:0 0 6px">Vous recevez cet e-mail parce que vous avez activé le point du lundi dans Bonplein. <a href="${unsubPage}" style="color:#1D2731">Ne plus recevoir le point du lundi</a></p>` +
      `<p style="margin:0">Une question ? Répondez à cet e-mail ou écrivez à <a href="mailto:contact@paceapp.fr" style="color:#1D2731">contact@paceapp.fr</a>.</p>` +
      `</div></div></div></body></html>`;
    const text = subject + "\n\n" + blocks.map(toText).join("\n\n") +
      `\n\nVoir les prix en direct : ${SITE}\n\nPrix relevés ce lundi dans le flux officiel prix-carburants.gouv.fr.\n` +
      `Vous recevez cet e-mail parce que vous avez activé le point du lundi dans Bonplein.\nNe plus le recevoir : ${unsubPage}\n` +
      `Une question ? Répondez à cet e-mail ou écrivez à contact@paceapp.fr.`;

    const headers: Record<string, string> = {};
    if (tok) { headers["List-Unsubscribe"] = `<${unsubApi}${encodeURIComponent(tok)}>`; headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"; }

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [s.email], subject, html, text, reply_to: replyTo, headers }),
    });
    if (r.ok) { sent++; await db.from("profils").update({ dernier_point: semaine }).eq("user_id", s.user_id); }
    else failed++;
  }
  return { sent, failed };
}
