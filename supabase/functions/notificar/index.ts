// Envia notificações (Web Push) para barbeiro e cliente a cada mudança de agendamento,
// e lembretes na véspera (chamado pelo cron às 18h de Brasília).
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
let seg: Record<string, string> | null = null;
async function segredos() {
  if (!seg) {
    const { data, error } = await sb.rpc("segredos_notificacao");
    if (error) throw error;
    seg = data;
    webpush.setVapidDetails("mailto:contato@space-agendamento.app", seg!.vapid_publica, seg!.vapid_privada);
  }
  return seg!;
}
const hm = (m: number) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const hojeBR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
function quando(day: string) {
  const amanha = new Date(Date.parse(hojeBR() + "T12:00:00Z") + 864e5).toISOString().slice(0, 10);
  if (day === hojeBR()) return "hoje";
  if (day === amanha) return "amanhã";
  const d = new Date(day + "T12:00:00Z");
  return d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" }).replace(".", "");
}
type Sub = { id: string; endpoint: string; p256dh: string; auth: string };
async function enviar(subs: Sub[], msg: { title: string; body: string; url: string; tag?: string }) {
  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: 86400, urgency: "high" });
      ok++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await sb.from("push_subs").delete().eq("id", s.id);
      else console.error("push falhou", e?.statusCode, e?.body);
    }
  }
  return ok;
}
async function loja(id: string) {
  const { data } = await sb.from("shops").select("id,slug,name,config").eq("id", id).single();
  return data!;
}
const nomeBarbeiro = (shop: any, id: string) => ((shop.config?.barbers || []).find((b: any) => b.id === id) || {}).name || "o barbeiro";
const subsBarbeiro = async (shopId: string) => (await sb.from("push_subs").select("id,endpoint,p256dh,auth").eq("papel", "barbeiro").eq("shop_id", shopId)).data || [];
const subsCliente = async (token: string) => (await sb.from("push_subs").select("id,endpoint,p256dh,auth").eq("papel", "cliente").contains("tokens", [token])).data || [];

async function mudanca(tipo: string, r: any, old: any) {
  const shop = await loja(r.shop_id);
  const linkCli = `/${shop.slug}#meus`, linkPro = `/${shop.slug}/painel#hoje`;
  const q = `${quando(r.day)} às ${hm(r.start_min)}`;
  const quem = nomeBarbeiro(shop, r.barber_id);
  if (tipo === "INSERT" && r.status === "pendente") {
    return { barbeiro: await enviar(await subsBarbeiro(shop.id), { title: "Novo pedido de horário", body: `${r.client_name} · ${r.svc_name} · ${q} com ${quem}. Toque para aceitar.`, url: linkPro, tag: "pedido-" + r.id }) };
  }
  if (tipo !== "UPDATE" || !old) return {};
  const res: Record<string, number> = {};
  if (r.status === "confirmado" && old.status === "pendente")
    res.cliente = await enviar(await subsCliente(r.manage_token), { title: `Confirmado na ${shop.name}`, body: `${r.svc_name} ${q} com ${quem}. Te esperamos!`, url: linkCli, tag: "pedido-" + r.id });
  if (r.status === "recusado")
    res.cliente = await enviar(await subsCliente(r.manage_token), { title: `${shop.name} não conseguiu esse horário`, body: `${quem} não pode ${q}. Toque para escolher outro.`, url: `/${shop.slug}`, tag: "pedido-" + r.id });
  if (r.status === "cancelado" && r.cancelado_por === "cliente")
    res.barbeiro = await enviar(await subsBarbeiro(shop.id), { title: "Cliente cancelou", body: `${r.client_name} cancelou ${r.svc_name} ${q}. O horário ficou livre.`, url: linkPro });
  if (r.status === "cancelado" && r.cancelado_por !== "cliente")
    res.cliente = await enviar(await subsCliente(r.manage_token), {
      title: r.motivo ? `${shop.name} não vai abrir ${quando(r.day)}` : `${shop.name} cancelou seu horário`,
      body: r.motivo ? `${r.motivo}. Seu horário das ${hm(r.start_min)} foi cancelado. Toque para marcar outro dia.` : `${r.svc_name} ${q} foi cancelado. Toque para marcar outro.`,
      url: `/${shop.slug}`,
    });
  return res;
}

async function lembretes() {
  const amanha = new Date(Date.parse(hojeBR() + "T12:00:00Z") + 864e5).toISOString().slice(0, 10);
  const { data: rows } = await sb.from("bookings").select("*").eq("day", amanha).eq("status", "confirmado").eq("lembrete_enviado", false).eq("is_example", false);
  const porLoja: Record<string, any[]> = {};
  let clientes = 0;
  for (const r of rows || []) {
    (porLoja[r.shop_id] ||= []).push(r);
    const shop = await loja(r.shop_id);
    clientes += await enviar(await subsCliente(r.manage_token), { title: `Amanhã é dia de ${r.svc_name.toLowerCase()}`, body: `${shop.name}, amanhã às ${hm(r.start_min)} com ${nomeBarbeiro(shop, r.barber_id)}. Não pode ir? Toque para cancelar.`, url: `/${shop.slug}#meus` });
    await sb.from("bookings").update({ lembrete_enviado: true }).eq("id", r.id);
  }
  let barbeiros = 0;
  for (const id in porLoja) {
    const l = porLoja[id].sort((a, b) => a.start_min - b.start_min);
    const shop = await loja(id);
    barbeiros += await enviar(await subsBarbeiro(id), { title: `Amanhã: ${l.length} ${l.length === 1 ? "cliente" : "clientes"}`, body: `Primeiro às ${hm(l[0].start_min)} (${l[0].client_name}). Toque para ver a agenda.`, url: `/${shop.slug}/painel#agenda` });
  }
  return { lembretes: rows?.length || 0, clientes, barbeiros };
}

Deno.serve(async (req) => {
  try {
    const s = await segredos();
    if (req.headers.get("x-space-secret") !== s.webhook) return new Response("nao autorizado", { status: 401 });
    const body = await req.json();
    const out = body.type === "LEMBRETES" ? await lembretes() : await mudanca(body.type, body.record, body.old);
    return Response.json({ ok: true, ...out });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, erro: String(e) }, { status: 500 });
  }
});
