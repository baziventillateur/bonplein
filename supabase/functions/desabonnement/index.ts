import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Désabonnement du point du lundi.
// - POST ?t=<jeton> : désabonne (bouton « Se désabonner » de Gmail, RFC 8058, et page de Bonplein).
// - GET  ?t=<jeton> : redirige vers la page de confirmation du site, sans rien modifier
//   (les robots qui ouvrent les liens des e-mails ne doivent pas désabonner les gens).
// Le jeton est propre à chaque profil et n'ouvre aucun autre droit.

const SITE = "https://bonplein.paceapp.fr/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

Deno.serve(async (req: Request) => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const t = new URL(req.url).searchParams.get("t") ?? "";
  if (req.method === "GET") return new Response(null, { status: 303, headers: { ...CORS, Location: SITE + "?desabo=" + encodeURIComponent(t) } });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  if (!UUID.test(t)) return json({ ok: false, error: "token" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data, error } = await db.rpc("desabonner", { p_token: t });
  if (error) return json({ ok: false, error: "db" }, 500);
  // 200 même pour un jeton inconnu (compte supprimé) : la messagerie doit voir le désabonnement comme réussi.
  return json({ ok: true, known: !!data });
});
