// Cobrança da mensalidade do app pelo Mercado Pago (Checkout Pro: crédito, débito e Pix).
// acao "link": o barbeiro logado recebe o link de pagamento da mensalidade.
// acao "testar": o dono do app confere se a chave do Mercado Pago funciona.
// ?src=mp: aviso do Mercado Pago. O pagamento é sempre conferido na API do Mercado Pago antes de liberar a conta.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const adm = createClient(URL_SB, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function chaveMP(): Promise<string | null> {
  const { data } = await adm.rpc("segredos_notificacao");
  return (data && data.mp_token) || null;
}
async function mp(path: string, token: string, init: RequestInit = {}) {
  const r = await fetch("https://api.mercadopago.com" + path, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`mercado_pago_${r.status}: ${body.message || ""}`);
  return body;
}
async function usuario(req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await adm.auth.getUser(jwt);
  return data.user || null;
}
const hojeBR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
function maisUmMes(d: string) {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCMonth(x.getUTCMonth() + 1);
  return x.toISOString().slice(0, 10);
}

async function confirmarPagamento(id: string) {
  const token = await chaveMP();
  if (!token) return { ignorado: "sem_chave" };
  const p = await mp(`/v1/payments/${encodeURIComponent(id)}`, token);
  if (p.status !== "approved") return { status: p.status };
  const ref = String(p.external_reference || "");
  const { data: shop } = await adm.from("shops").select("id,vence,status").eq("id", ref).maybeSingle();
  if (!shop) return { ignorado: "sem_barbearia" };
  const { error } = await adm.from("pagamentos").insert({ id: String(p.id), shop_id: shop.id, valor: p.transaction_amount, metodo: p.payment_type_id });
  if (error) return { ignorado: "ja_registrado" };
  const base = shop.vence > hojeBR() ? shop.vence : hojeBR();
  await adm.from("shops").update({ vence: maisUmMes(base), status: "ativo", aviso: null }).eq("id", shop.id);
  return { liberado: shop.id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  try {
    if (url.searchParams.get("src") === "mp") {
      const body = await req.json().catch(() => ({}));
      const tipo = body.type || body.topic || url.searchParams.get("type") || url.searchParams.get("topic");
      const id = (body.data && body.data.id) || url.searchParams.get("data.id") || url.searchParams.get("id");
      if (tipo === "payment" && id) return json(await confirmarPagamento(String(id)));
      return json({ ok: true });
    }
    const body = await req.json().catch(() => ({}));
    const user = await usuario(req);
    if (!user) return json({ erro: "precisa_login" }, 401);
    const token = await chaveMP();
    if (body.acao === "testar") {
      const { data: ok } = await adm.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle();
      if (!ok) return json({ erro: "sem_permissao" }, 403);
      if (!token) return json({ erro: "sem_chave" }, 400);
      const me = await mp("/users/me", token);
      return json({ ok: true, conta: me.nickname || me.email || me.id, email: me.email || "" });
    }
    if (body.acao === "link") {
      if (!token) return json({ erro: "sem_chave" }, 400);
      const { data: shop } = await adm.from("shops").select("id,slug,name,mensalidade").eq("owner", user.id).maybeSingle();
      if (!shop) return json({ erro: "sem_barbearia" }, 404);
      const origem = /^https:\/\//.test(body.origem || "") ? body.origem : "https://space-agendamento.vercel.app";
      const pref = await mp("/checkout/preferences", token, {
        method: "POST",
        body: JSON.stringify({
          items: [{ id: "mensalidade-space", title: `Mensalidade Space · ${shop.name}`, quantity: 1, unit_price: Number(shop.mensalidade), currency_id: "BRL" }],
          external_reference: shop.id,
          payer: { email: user.email },
          notification_url: `${URL_SB}/functions/v1/cobranca?src=mp`,
          back_urls: { success: `${origem}/${shop.slug}/painel#ajustes`, pending: `${origem}/${shop.slug}/painel#ajustes`, failure: `${origem}/${shop.slug}/painel#ajustes` },
          auto_return: "approved",
          statement_descriptor: "SPACE APP",
        }),
      });
      return json({ ok: true, url: pref.init_point });
    }
    return json({ erro: "acao_invalida" }, 400);
  } catch (e) {
    console.error(e);
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
