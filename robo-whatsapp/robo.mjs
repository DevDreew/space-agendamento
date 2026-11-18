// Robô de WhatsApp do DreewSolution.
// Fica ligado no seu computador, conectado a um WhatsApp por QR code, e envia sozinho as mensagens
// que o app coloca na fila: pedido novo para o barbeiro, confirmação, recusa e lembrete para o cliente.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE = "https://yxfhlmgxgyystthnfhfd.supabase.co";
const CHAVE_PUBLICA = "sb_publishable_BrrNsjOH5oRuGHHVCEG1mA_aJeX5mbL"; // chave pública do app (a mesma do site)
const INTERVALO = 4000;      // olha a fila a cada 4 segundos
const PAUSA_ENVIO = 1500;    // espera entre uma mensagem e outra, para o WhatsApp não estranhar
const TESTE = process.argv.includes("--teste");

const hora = () => new Date().toLocaleTimeString("pt-BR");
const log = (...a) => console.log(`[${hora()}]`, ...a);
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(PASTA, "config.json"), "utf8"));
} catch {
  console.log("\nFalta o arquivo config.json.");
  console.log("Copie config.exemplo.json para config.json e cole a chave do robô que aparece no painel do dono do app.\n");
  process.exit(1);
}
if (!config.chave || config.chave.startsWith("COLE_AQUI")) {
  console.log("\nCole a chave do robô no config.json (painel do dono → WhatsApp automático → Robô no computador).\n");
  process.exit(1);
}

async function rpc(nome, corpo) {
  const r = await fetch(`${SUPABASE}/rest/v1/rpc/${nome}`, {
    method: "POST",
    headers: { apikey: CHAVE_PUBLICA, Authorization: `Bearer ${CHAVE_PUBLICA}`, "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : null;
}

let sock = null;
let conectado = false;

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(PASTA, "sessao-whatsapp"));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  sock = makeWASocket({ auth: state, version, logger: pino({ level: "silent" }), browser: ["DreewSolution", "Chrome", "1.0"], markOnlineOnConnect: false });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\nAbra o WhatsApp do número do app → Aparelhos conectados → Conectar aparelho, e leia este QR code:\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") { conectado = true; log("✅ WhatsApp conectado. O robô está enviando as mensagens."); }
    if (connection === "close") {
      conectado = false;
      const motivo = lastDisconnect?.error?.output?.statusCode;
      if (motivo === DisconnectReason.loggedOut) {
        log("O WhatsApp foi desconectado pelo celular. Apague a pasta sessao-whatsapp e abra o robô de novo para ler o QR code.");
        process.exit(1);
      }
      log("Conexão caiu. Tentando de novo em 5 segundos...");
      setTimeout(conectar, 5000);
    }
  });
}

async function jidDe(phone) {
  // O WhatsApp de alguns números antigos do Brasil não usa o 9; perguntamos ao WhatsApp qual é o certo.
  const num = String(phone).replace(/\D/g, "");
  const tentativas = [num];
  if (num.length === 13 && num.startsWith("55")) tentativas.push(num.slice(0, 4) + num.slice(5));
  for (const n of tentativas) {
    try {
      const [r] = await sock.onWhatsApp(n);
      if (r?.exists) return r.jid;
    } catch {}
  }
  return null;
}

async function ciclo() {
  if (!TESTE && !conectado) return;
  let lista = [];
  try {
    lista = (await rpc("robo_pegar", { p_chave: config.chave })) || [];
  } catch (e) {
    if (String(e.message).includes("chave_robo_invalida")) { log("A chave do config.json não vale mais. Copie a chave nova do painel do dono."); process.exit(1); }
    log("Sem conexão com o app agora:", e.message);
    return;
  }
  for (const m of lista) {
    try {
      if (TESTE) {
        log(`(teste) mensagem ${m.id} para ${m.phone}:\n${m.texto}\n`);
        await rpc("robo_marcar", { p_chave: config.chave, p_id: m.id, p_ok: false, p_erro: "modo teste: não enviada" });
        continue;
      }
      const jid = await jidDe(m.phone);
      if (!jid) {
        await rpc("robo_marcar", { p_chave: config.chave, p_id: m.id, p_ok: false, p_erro: "número sem WhatsApp" });
        log(`⚠️  ${m.phone} não tem WhatsApp. Mensagem ${m.id} não enviada.`);
        continue;
      }
      await sock.sendMessage(jid, { text: m.texto });
      await rpc("robo_marcar", { p_chave: config.chave, p_id: m.id, p_ok: true });
      log(`📤 Enviada para ${m.phone}: ${m.texto.split("\n")[0]}`);
      await dorme(PAUSA_ENVIO);
    } catch (e) {
      log(`Falhou a mensagem ${m.id}:`, e.message);
      try { await rpc("robo_marcar", { p_chave: config.chave, p_id: m.id, p_ok: false, p_erro: String(e.message).slice(0, 250) }); } catch {}
    }
  }
}

console.log("\n=== Robô de WhatsApp · DreewSolution ===");
console.log("Deixe esta janela aberta. Fechou, o robô para e o app volta a pedir para o cliente enviar pelo WhatsApp dele.\n");
if (TESTE) log("Modo teste: só mostra as mensagens na tela, sem enviar.");
else await conectar();
// Avisa o app que o robô está ligado, mesmo sem mensagens na fila.
setInterval(() => { ciclo().catch((e) => log("Erro:", e.message)); }, INTERVALO);
ciclo().catch(() => {});
