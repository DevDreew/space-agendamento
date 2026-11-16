// Cobrança da mensalidade do app pelo Mercado Pago.
// acao "link": pagamento avulso do mês (Pix, débito ou crédito) pelo Checkout Pro.
// acao "assinar": débito automático mensal no cartão de crédito (assinatura do Mercado Pago).
// acao "cancelar_auto": cancela o débito automático.
// acao "sincronizar": confere no Mercado Pago os pagamentos da barbearia (ou de todas, se for o dono do app).
// acao "testar": o dono do app confere se a chave funciona.
// ?src=cron: conferência diária de todas as barbearias (chamada pelo agendador do banco).
// acao "senha": o dono do app cria uma senha nova para o dono de uma barbearia.
// ?src=mp: avisos do Mercado Pago (pagamentos e assinaturas). Tudo é conferido na API do Mercado Pago antes de liberar.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const adm = createClient(URL_SB, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const SITE = "https://space-agendamento.vercel.app";
const AVISO_MP = `${URL_SB}/functions/v1/cobranca?src=mp`;

async function segredos(): Promise<any> {
  const { data } = await adm.rpc("segredos_notificacao");
  return data || {};
}
async function chaveMP(): Promise<string | null> {
  return (await segredos()).mp_token || null;
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
async function ehAdmin(id: string) {
  const { data } = await adm.from("platform_admins").select("user_id").eq("user_id", id).maybeSingle();
  return !!data;
}
const hojeBR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
function maisUmMes(d: string) {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCMonth(x.getUTCMonth() + 1);
  return x.toISOString().slice(0, 10);
}

// Registra um pagamento aprovado uma única vez (o id do Mercado Pago impede repetição) e libera mais um mês.
async function registrar(shopId: string, pagId: string, valor: number, metodo: string, quando?: string) {
  const { data: shop } = await adm.from("shops").select("id,vence").eq("id", shopId).maybeSingle();
  if (!shop) return false;
  const { error } = await adm.from("pagamentos").insert({ id: pagId, shop_id: shop.id, valor, metodo, pago_em: quando || new Date().toISOString() });
  if (error) return false;
  const base = shop.vence > hojeBR() ? shop.vence : hojeBR();
  await adm.from("shops").update({ vence: maisUmMes(base), status: "ativo", aviso: null }).eq("id", shop.id);
  return true;
}

async function lojaDoPagamento(p: any): Promise<string | null> {
  const ref = String(p.external_reference || "");
  if (/^[0-9a-f-]{36}$/i.test(ref)) {
    const { data } = await adm.from("shops").select("id").eq("id", ref).maybeSingle();
    if (data) return data.id;
  }
  const sub = (p.metadata && p.metadata.preapproval_id) || (p.point_of_interaction && p.point_of_interaction.transaction_data && p.point_of_interaction.transaction_data.subscription_id);
  if (sub) {
    const { data } = await adm.from("shops").select("id").eq("mp_assinatura_id", String(sub)).maybeSingle();
    if (data) return data.id;
  }
  return null;
}

async function confirmarPagamento(id: string, token: string) {
  const p = await mp(`/v1/payments/${encodeURIComponent(id)}`, token);
  if (p.status !== "approved") return { status: p.status };
  const shop = await lojaDoPagamento(p);
  if (!shop) return { ignorado: "sem_barbearia" };
  return { liberado: await registrar(shop, String(p.id), Number(p.transaction_amount), p.payment_type_id || "mp", p.date_approved) };
}

async function atualizarAssinatura(preId: string, token: string) {
  const s = await mp(`/preapproval/${encodeURIComponent(preId)}`, token);
  const prox = s.next_payment_date ? String(s.next_payment_date).slice(0, 10) : null;
  await adm.from("shops").update({ mp_assinatura_status: s.status, mp_proxima: prox }).eq("mp_assinatura_id", preId);
  return s;
}

async function confirmarCobrancaAutomatica(id: string, token: string) {
  const a = await mp(`/authorized_payments/${encodeURIComponent(id)}`, token);
  const pg = a.payment || {};
  if (pg.status !== "approved" || !pg.id) return { status: pg.status || a.status };
  const { data: shop } = await adm.from("shops").select("id").eq("mp_assinatura_id", String(a.preapproval_id)).maybeSingle();
  if (!shop) return { ignorado: "sem_barbearia" };
  return { liberado: await registrar(shop.id, String(pg.id), Number(a.transaction_amount || 0), "debito_automatico", a.last_modified || a.date_created) };
}

// Confere tudo de uma barbearia direto no Mercado Pago (cobre o caso de um aviso do Mercado Pago não ter chegado).
async function sincronizar(shop: any, token: string) {
  let novos = 0;
  if (shop.mp_assinatura_id) {
    try {
      const s = await atualizarAssinatura(shop.mp_assinatura_id, token);
      // Se o dono do app mudou o valor da mensalidade, o débito automático passa a cobrar o valor novo.
      const atual = Number(s.auto_recurring && s.auto_recurring.transaction_amount);
      if (["authorized", "pending", "paused"].includes(s.status) && shop.mensalidade != null && atual !== Number(shop.mensalidade)) {
        await mp(`/preapproval/${encodeURIComponent(shop.mp_assinatura_id)}`, token, { method: "PUT", body: JSON.stringify({ auto_recurring: { transaction_amount: Number(shop.mensalidade), currency_id: "BRL" } }) });
      }
      const r = await mp(`/authorized_payments/search?preapproval_id=${encodeURIComponent(shop.mp_assinatura_id)}`, token);
      for (const a of r.results || []) {
        const pg = a.payment || {};
        if (pg.status === "approved" && pg.id && await registrar(shop.id, String(pg.id), Number(a.transaction_amount || 0), "debito_automatico", a.last_modified || a.date_created)) novos++;
      }
    } catch (e) { console.error("sync assinatura", e); }
  }
  try {
    const r = await mp(`/v1/payments/search?external_reference=${encodeURIComponent(shop.id)}&status=approved&sort=date_created&criteria=desc&limit=30`, token);
    for (const p of r.results || []) {
      if (await registrar(shop.id, String(p.id), Number(p.transaction_amount), p.payment_type_id || "mp", p.date_approved)) novos++;
    }
  } catch (e) { console.error("sync pagamentos", e); }
  return novos;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  try {
    if (url.searchParams.get("src") === "mp") {
      const token = await chaveMP();
      if (!token) return json({ ignorado: "sem_chave" });
      const body = await req.json().catch(() => ({}));
      const tipo = body.type || body.topic || url.searchParams.get("type") || url.searchParams.get("topic");
      const id = String((body.data && body.data.id) || url.searchParams.get("data.id") || url.searchParams.get("id") || "");
      if (!id) return json({ ok: true });
      if (tipo === "payment") return json(await confirmarPagamento(id, token));
      if (tipo === "subscription_preapproval" || tipo === "preapproval") { await atualizarAssinatura(id, token); return json({ ok: true }); }
      if (tipo === "subscription_authorized_payment" || tipo === "authorized_payment") return json(await confirmarCobrancaAutomatica(id, token));
      return json({ ok: true });
    }
    if (url.searchParams.get("src") === "cron") {
      const sg = await segredos();
      if (!sg.webhook || req.headers.get("x-space-secret") !== sg.webhook) return json({ erro: "sem_permissao" }, 403);
      if (!sg.mp_token) return json({ ok: true, novos: 0 });
      const lojas = (await adm.from("shops").select("id,mp_assinatura_id,mensalidade")).data || [];
      let novos = 0;
      for (const s of lojas) novos += await sincronizar(s, sg.mp_token);
      return json({ ok: true, novos });
    }
    const body = await req.json().catch(() => ({}));
    const user = await usuario(req);
    if (!user) return json({ erro: "precisa_login" }, 401);
    const token = await chaveMP();
    const origem = /^https:\/\//.test(body.origem || "") ? body.origem : SITE;

    if (body.acao === "testar") {
      if (!(await ehAdmin(user.id))) return json({ erro: "sem_permissao" }, 403);
      if (!token) return json({ erro: "sem_chave" }, 400);
      const me = await mp("/users/me", token);
      return json({ ok: true, conta: me.nickname || me.email || me.id, email: me.email || "" });
    }
    if (body.acao === "senha") {
      if (!(await ehAdmin(user.id))) return json({ erro: "sem_permissao" }, 403);
      const { data: shop } = await adm.from("shops").select("owner").eq("id", body.shop).maybeSingle();
      if (!shop || !shop.owner) return json({ erro: "sem_barbearia" }, 404);
      const letras = "abcdefghjkmnpqrstuvwxyz23456789";
      const rnd = crypto.getRandomValues(new Uint8Array(10));
      const senha = Array.from(rnd, (n) => letras[n % letras.length]).join("");
      const { error } = await adm.auth.admin.updateUserById(shop.owner, { password: senha });
      if (error) throw error;
      return json({ ok: true, senha });
    }
    if (body.acao === "sincronizar") {
      if (!token) return json({ ok: true, novos: 0 });
      const cols = "id,mp_assinatura_id,mensalidade";
      let lojas: any[] = [];
      if (body.todas && (await ehAdmin(user.id))) lojas = (await adm.from("shops").select(cols)).data || [];
      else lojas = (await adm.from("shops").select(cols).eq("owner", user.id)).data || [];
      let novos = 0;
      for (const s of lojas) novos += await sincronizar(s, token);
      return json({ ok: true, novos });
    }

    const { data: shop } = await adm.from("shops").select("id,slug,name,mensalidade,mp_assinatura_id,mp_assinatura_status").eq("owner", user.id).maybeSingle();
    if (!shop) return json({ erro: "sem_barbearia" }, 404);
    if (!token) return json({ erro: "sem_chave" }, 400);
    const volta = `${origem}/${shop.slug}/painel`;

    if (body.acao === "link") {
      const pref = await mp("/checkout/preferences", token, {
        method: "POST",
        body: JSON.stringify({
          items: [{ id: "mensalidade-space", title: `Mensalidade Space · ${shop.name}`, quantity: 1, unit_price: Number(shop.mensalidade), currency_id: "BRL" }],
          external_reference: shop.id,
          payer: { email: user.email },
          notification_url: AVISO_MP,
          back_urls: { success: volta, pending: volta, failure: volta },
          auto_return: "approved",
          statement_descriptor: "SPACE APP",
        }),
      });
      return json({ ok: true, url: pref.init_point });
    }
    if (body.acao === "assinar") {
      const email = String(body.email || user.email || "").trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) return json({ erro: "email_invalido" }, 400);
      if (shop.mp_assinatura_id && shop.mp_assinatura_status === "authorized") return json({ erro: "ja_assinado" }, 400);
      if (shop.mp_assinatura_id) { try { await mp(`/preapproval/${shop.mp_assinatura_id}`, token, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) }); } catch (_) { /* já estava encerrada */ } }
      const s = await mp("/preapproval", token, {
        method: "POST",
        body: JSON.stringify({
          reason: `Mensalidade Space · ${shop.name}`,
          external_reference: shop.id,
          payer_email: email,
          auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: Number(shop.mensalidade), currency_id: "BRL" },
          back_url: volta,
          status: "pending",
        }),
      });
      await adm.from("shops").update({ mp_assinatura_id: s.id, mp_assinatura_status: s.status || "pending", mp_proxima: null }).eq("id", shop.id);
      return json({ ok: true, url: s.init_point });
    }
    if (body.acao === "cancelar_auto") {
      if (shop.mp_assinatura_id) await mp(`/preapproval/${shop.mp_assinatura_id}`, token, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
      await adm.from("shops").update({ mp_assinatura_status: "cancelled", mp_proxima: null }).eq("id", shop.id);
      return json({ ok: true });
    }
    return json({ erro: "acao_invalida" }, 400);
  } catch (e) {
    console.error(e);
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
