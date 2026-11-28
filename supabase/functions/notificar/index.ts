// Envia notificações (Web Push) para barbeiro e cliente a cada mudança de agendamento,
// lembretes na véspera (18h de Brasília) e na manhã do dia (8h de Brasília).
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
// WhatsApp automático: pela Z-API ou pelo robô do computador (fila zap_fila). Um número do app manda para o barbeiro e para o cliente.
const brl = (v: number) => "R$ " + Number(v || 0).toFixed(2).replace(".", ",").replace(",00", "");
const dataBR = (d: string) => d.split("-").reverse().join("/");
const fone = (t: string) => String(t || "").replace(/^(\d{2})(\d{5})(\d{4})$/, "($1) $2-$3");
function telZap(t: string) {
  let d = String(t || "").replace(/\D/g, "");
  if (d.length >= 12 && d.startsWith("55")) d = d.slice(2);
  if (d.length === 9) d = "11" + d;
  return /^[1-9][1-9]9\d{8}$/.test(d) ? d : "";
}
// O robô só manda mensagem para o BARBEIRO. Com o cliente, quem fala é o próprio barbeiro,
// pelo WhatsApp dele: o painel abre a conversa com a mensagem pronta (confirmar, recusar, cancelar).
async function zapCliente(_tel: string, _texto: string) { return 0; }
const linkZap = (tel: string) => { const d = String(tel || "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, ""); return d.length >= 10 ? `https://wa.me/55${d}` : ""; };

async function zap(tel: string, texto: string) {
  await segredos();
  const { data: s } = await sb.rpc("segredos_notificacao"); // sempre a chave mais nova
  const n = telZap(tel);
  if (!s || !n) return 0;
  if (!s.zapi_instancia || !s.zapi_token) {
    // Sem Z-API: se o robô do computador estiver ligado, a mensagem entra na fila e ele envia.
    if (!s.robo_chave) return 0;
    const { error } = await sb.from("zap_fila").insert({ phone: "55" + n, texto });
    if (error) { console.error("fila", error); return 0; }
    return 1;
  }
  try {
    const r = await fetch(`https://api.z-api.io/instances/${s.zapi_instancia}/token/${s.zapi_token}/send-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Client-Token": s.zapi_client || "" },
      body: JSON.stringify({ phone: "55" + n, message: texto }),
    });
    if (!r.ok) { console.error("zap falhou", r.status, await r.text()); return 0; }
    return 1;
  } catch (e) { console.error("zap erro", e); return 0; }
}
const zapDoBarbeiro = (shop: any, id: string) => ((shop.config?.barbers || []).find((b: any) => b.id === id) || {}).whatsapp || shop.config?.whatsapp || "";
const linhas = (r: any, shop: any, quem: string) => `💈 Serviço: ${r.svc_name}${Number(r.price) ? " · " + brl(r.price) : ""}\n📅 Data: ${dataBR(r.day)}\n⏰ Horário: ${hm(r.start_min)}\n🧔 Barbeiro: ${quem}`;
const nomeBarbeiro = (shop: any, id: string) => ((shop.config?.barbers || []).find((b: any) => b.id === id) || {}).name || "o barbeiro";
const subsBarbeiro = async (shopId: string) => (await sb.from("push_subs").select("id,endpoint,p256dh,auth").eq("papel", "barbeiro").eq("shop_id", shopId)).data || [];
const subsCliente = async (token: string) => (await sb.from("push_subs").select("id,endpoint,p256dh,auth").eq("papel", "cliente").contains("tokens", [token])).data || [];

const SITE = "https://dreewsolution.vercel.app";
function confirmacao(r: any, shop: any, quem: string) {
  const end = shop.config?.address ? `\n📍 Endereço: ${shop.config.address}` : "";
  return `✅ *Horário confirmado · ${shop.name}*\n\nOlá, ${String(r.client_name || "").split(" ")[0]}! Te espero:\n\n${linhas(r, shop, quem)}${end}\n\nSe não puder vir, é só responder esta mensagem ou cancelar em ${SITE}/${shop.slug}#meus`;
}
async function mudanca(tipo: string, r: any, old: any) {
  const shop = await loja(r.shop_id);
  const linkCli = `/${shop.slug}#meus`, linkPro = `/${shop.slug}/painel#hoje`;
  const q = `${quando(r.day)} às ${hm(r.start_min)}`;
  const quem = nomeBarbeiro(shop, r.barber_id);
  if (tipo === "INSERT" && r.status === "pendente") {
    const tel = String(r.client_phone || "").replace(/^(\d{2})(\d{5})(\d{4})$/, "($1) $2-$3");
    const zapB = await zap(zapDoBarbeiro(shop, r.barber_id), `📌 *Novo agendamento · ${shop.name}*\n\n👤 Cliente: ${r.client_name}\n📱 WhatsApp: ${fone(r.client_phone)}\n${linhas(r, shop, quem)}${r.note ? `\n📝 Recado: ${r.note}` : ""}\n\n✅ Aceite ou recuse aqui: ${SITE}/${shop.slug}/painel`);
    return { zap: zapB, barbeiro: await enviar(await subsBarbeiro(shop.id), { title: `Novo agendamento · ${r.client_name}`, body: `${r.svc_name} · ${q} com ${quem}${tel ? ` · ${tel}` : ""}. Toque para ver.`, url: linkPro, tag: "pedido-" + r.id }) };
  }
  if (tipo === "INSERT" && r.status === "confirmado" && r.client_phone) {
    return { zap: await zapCliente(r.client_phone, confirmacao(r, shop, quem)) };
  }
  if (tipo !== "UPDATE" || !old) return {};
  const res: Record<string, number> = {};
  if (r.status === "confirmado" && old.status === "pendente") {
    res.cliente = await enviar(await subsCliente(r.manage_token), { title: `Confirmado na ${shop.name}`, body: `${r.svc_name} ${q} com ${quem}. Te esperamos!`, url: linkCli, tag: "pedido-" + r.id });
    res.zap = await zapCliente(r.client_phone, confirmacao(r, shop, quem));
  }
  if (r.status === "recusado" && old.status !== "recusado")
    res.zap = await zapCliente(r.client_phone, `*${shop.name}*\n\nOlá, ${String(r.client_name || "").split(" ")[0]}! ${quem} não conseguiu atender ${q}. Escolha outro horário aqui: ${SITE}/${shop.slug}`);
  if (r.status === "recusado")
    res.cliente = await enviar(await subsCliente(r.manage_token), { title: `${shop.name} não conseguiu esse horário`, body: `${quem} não pode ${q}. Toque para escolher outro.`, url: `/${shop.slug}`, tag: "pedido-" + r.id });
  if (r.status === "cancelado" && old.status !== "cancelado" && r.cancelado_por === "cliente")
    res.zap = await zap(zapDoBarbeiro(shop, r.barber_id), `❌ *Horário cancelado · ${shop.name}*\n\n👤 Cliente: ${r.client_name}\n📱 WhatsApp: ${fone(r.client_phone)}\n${linhas(r, shop, quem)}\n\nO horário já está livre na agenda.`);
  if (r.status === "cancelado" && old.status !== "cancelado" && r.cancelado_por !== "cliente" && old.status !== "pendente")
    res.zapCli = await zapCliente(r.client_phone, `*${shop.name}*\n\nOlá, ${String(r.client_name || "").split(" ")[0]}! ${r.motivo ? r.motivo + ". " : ""}Seu horário de ${q} foi cancelado. Marque outro aqui: ${SITE}/${shop.slug}`);
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

async function assinatura(b: any) {
  const shop = await loja(b.shop_id);
  const url = `/${shop.slug}/painel#ajustes`;
  let msg;
  if (b.status === "suspenso") msg = { title: "Conta do app suspensa", body: b.aviso || "Sua mensalidade está em aberto. Toque para pagar e liberar a agenda.", url };
  else if (b.status === "ativo" && b.antes !== "ativo") msg = { title: "Conta liberada", body: "Pagamento confirmado. Sua agenda já está recebendo clientes.", url: `/${shop.slug}/painel#hoje` };
  else if (b.aviso) msg = { title: "Mensalidade do app", body: b.aviso, url };
  if (!msg) return {};
  return { barbeiro: await enviar(await subsBarbeiro(shop.id), msg) };
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

// Manhã do dia (8h de Brasília): lembra o cliente que hoje tem horário e manda ao barbeiro o resumo do dia.
async function lembretesHoje() {
  const hoje = hojeBR();
  const { data: rows } = await sb.from("bookings").select("*").eq("day", hoje).eq("status", "confirmado").eq("lembrete_hoje", false).eq("is_example", false);
  const porLoja: Record<string, any[]> = {};
  let clientes = 0;
  for (const r of rows || []) {
    (porLoja[r.shop_id] ||= []).push(r);
    const shop = await loja(r.shop_id);
    const end = shop.config?.address ? ` ${shop.config.address}.` : "";
    await zapCliente(r.client_phone, `⏰ *Lembrete · ${shop.name}*\n\nBom dia, ${String(r.client_name || "").split(" ")[0]}! Seu horário é *hoje*:\n\n${linhas(r, shop, nomeBarbeiro(shop, r.barber_id))}${shop.config?.address ? `\n📍 Endereço: ${shop.config.address}` : ""}\n\nNão pode vir? Responda esta mensagem.`);
    clientes += await enviar(await subsCliente(r.manage_token), { title: `Hoje é dia de ${r.svc_name.toLowerCase()}!`, body: `${shop.name}, hoje às ${hm(r.start_min)} com ${nomeBarbeiro(shop, r.barber_id)}.${end} Não pode ir? Toque para cancelar.`, url: `/${shop.slug}#meus`, tag: "hoje-" + r.id });
    await sb.from("bookings").update({ lembrete_hoje: true }).eq("id", r.id);
  }
  let barbeiros = 0;
  for (const id in porLoja) {
    const l = porLoja[id].sort((a, b) => a.start_min - b.start_min);
    const shop = await loja(id);
    barbeiros += await enviar(await subsBarbeiro(id), { title: `Hoje: ${l.length} ${l.length === 1 ? "cliente" : "clientes"}`, body: `Primeiro às ${hm(l[0].start_min)} (${l[0].client_name}). Toque para ver e lembrar no WhatsApp.`, url: `/${shop.slug}/painel#hoje` });
  }
  return { hoje: rows?.length || 0, clientes, barbeiros };
}

Deno.serve(async (req) => {
  try {
    const s = await segredos();
    if (req.headers.get("x-space-secret") !== s.webhook) return new Response("nao autorizado", { status: 401 });
    const body = await req.json();
    if (body.type === "TESTE_ZAP") return Response.json({ ok: true, zap: await zap(body.phone, "✅ *DreewSolution*\n\nWhatsApp automático ligado. A partir de agora os agendamentos chegam sozinhos. 💈") });
    const out = body.type === "LEMBRETES" ? await lembretes() : body.type === "LEMBRETES_HOJE" ? await lembretesHoje() : body.type === "ASSINATURA" ? await assinatura(body) : await mudanca(body.type, body.record, body.old);
    return Response.json({ ok: true, ...out });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, erro: String(e) }, { status: 500 });
  }
});
