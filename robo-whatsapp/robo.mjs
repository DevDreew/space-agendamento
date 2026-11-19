// Robô de WhatsApp do DreewSolution.
// Fica ligado no seu computador, conectado a um WhatsApp por QR code, e envia sozinho as mensagens
// que o app coloca na fila: pedido novo para o barbeiro, confirmação, recusa e lembrete para o cliente.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from "baileys";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import readline from "node:readline/promises";
import { exec } from "node:child_process";
import pino from "pino";

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE = "https://yxfhlmgxgyystthnfhfd.supabase.co";
const CHAVE_PUBLICA = "sb_publishable_BrrNsjOH5oRuGHHVCEG1mA_aJeX5mbL"; // chave pública do app (a mesma do site)
const INTERVALO = 4000;      // olha a fila a cada 4 segundos
const PAUSA_ENVIO = 1500;    // espera entre uma mensagem e outra, para o WhatsApp não estranhar
const TESTE = process.argv.includes("--teste");
const SERVIDOR = process.argv.includes("--servidor") || !process.stdin.isTTY;

const hora = () => new Date().toLocaleTimeString("pt-BR");
const log = (...a) => console.log(`[${hora()}]`, ...a);
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

let config;
try {
  config = process.env.ROBO_CHAVE ? { chave: process.env.ROBO_CHAVE } : JSON.parse(fs.readFileSync(path.join(PASTA, "config.json"), "utf8"));
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

const SESSAO = path.join(PASTA, "sessao-whatsapp");
const PAGINA_QR = path.join(PASTA, "qr-code.html");
let numeroPareamento = null;
let codigoPedido = false;
let qrAberto = false;

function abrir(arquivo) {
  const cmd = process.platform === "win32" ? `start "" "${arquivo}"` : process.platform === "darwin" ? `open "${arquivo}"` : `xdg-open "${arquivo}"`;
  exec(cmd, () => {});
}

async function mostrarQR(qr) {
  console.log("\nLeia este QR code no celular: WhatsApp > Aparelhos conectados > Conectar um aparelho.");
  console.log("Se o QR da tela preta não ler, use o que abriu no navegador (arquivo qr-code.html).\n");
  qrcode.generate(qr, { small: true });
  const img = await QRCode.toDataURL(qr, { width: 360, margin: 2 });
  fs.writeFileSync(PAGINA_QR, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Conectar WhatsApp</title><body style="font-family:sans-serif;text-align:center;background:#111;color:#eee;padding:30px"><h2>Robô DreewSolution</h2><p>No celular: WhatsApp &gt; Aparelhos conectados &gt; Conectar um aparelho</p><img src="${img}" style="background:#fff;padding:10px;border-radius:12px"><p style="color:#aaa">O código muda a cada 20 segundos. Esta página atualiza sozinha.</p></body>`);
  if (!qrAberto) { qrAberto = true; abrir(PAGINA_QR); }
}

let estado = "iniciando";
let codigoAtual = null;
async function informar() {
  try {
    const r = await rpc("robo_info", { p_chave: config.chave, p_info: { estado, codigo: codigoAtual, numero: (sock?.user?.id || "").split(":")[0] || null, onde: SERVIDOR ? "servidor" : "computador", versao: 2 } });
    if (r?.parear && !conectado && r.parear !== numeroPareamento) {
      numeroPareamento = r.parear; codigoPedido = false;
      log("Painel pediu para conectar o número " + numeroPareamento + ". Gerando código...");
      try { sock?.end?.(new Error("novo pareamento")); } catch {}
    }
  } catch (e) {
    if (String(e.message).includes("chave_robo_invalida")) { log("A chave não vale mais. Pegue a chave nova no painel do dono."); process.exit(1); }
  }
}

async function perguntarNumero() {
  if (SERVIDOR) return config.numero ? String(config.numero).replace(/\D/g, "") : null;
  if (fs.existsSync(path.join(SESSAO, "creds.json"))) return null;
  if (config.numero) return String(config.numero).replace(/\D/g, "");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\nComo quer conectar o WhatsApp que vai ENVIAR as mensagens?");
  console.log("  - Digite o número com DDD (ex: 11912345678) para receber um código de 8 letras");
  console.log("  - Ou só aperte Enter para usar QR code");
  const r = (await rl.question("> ")).replace(/\D/g, "");
  rl.close();
  if (!r) return null;
  return r.startsWith("55") ? r : "55" + r;
}

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSAO);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  sock = makeWASocket({ auth: state, version, logger: pino({ level: "silent" }), browser: Browsers.windows("Chrome"), markOnlineOnConnect: false, syncFullHistory: false });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      if (numeroPareamento && !state.creds.registered) {
        if (!codigoPedido) {
          codigoPedido = true;
          try {
            const codigo = await sock.requestPairingCode(numeroPareamento);
            codigoAtual = (codigo.match(/.{1,4}/g) || [codigo]).join("-"); estado = "aguardando_codigo"; informar();
            console.log("\n==============================================");
            console.log("   SEU CÓDIGO:  " + (codigo.match(/.{1,4}/g) || [codigo]).join("-"));
            console.log("==============================================");
            console.log("No celular do número " + numeroPareamento + ":");
            console.log("WhatsApp > Aparelhos conectados > Conectar um aparelho >");
            console.log("'Conectar com número de telefone' e digite o código acima.\n");
          } catch (e) {
            log("Não consegui pedir o código (" + e.message + "). Vamos de QR code.");
            numeroPareamento = null;
            await mostrarQR(qr);
          }
        }
      } else if (SERVIDOR) { if (estado !== "aguardando_numero") { estado = "aguardando_numero"; log("Aguardando o número no painel do dono (WhatsApp automático > Conectar)."); informar(); } }
      else await mostrarQR(qr);
    }
    if (connection === "open") {
      conectado = true; estado = "conectado"; codigoAtual = null; informar();
      try { fs.unlinkSync(PAGINA_QR); } catch {}
      log("✅ WhatsApp conectado (" + (sock.user?.id || "").split(":")[0] + "). O robô está enviando as mensagens.");
    }
    if (connection === "close") {
      conectado = false; if (estado === "conectado") estado = "desconectado";
      const motivo = lastDisconnect?.error?.output?.statusCode;
      if (motivo === DisconnectReason.loggedOut) {
        log("O WhatsApp foi desconectado pelo celular. Apagando a sessão; abra o robô de novo para conectar.");
        fs.rmSync(SESSAO, { recursive: true, force: true });
        estado = "desconectado"; numeroPareamento = null; codigoAtual = null; await informar();
        if (SERVIDOR) { setTimeout(conectar, 5000); return; }
        process.exit(1);
      }
      if (motivo === DisconnectReason.restartRequired) { log("Conectando..."); return conectar(); }
      log(`Conexão caiu (código ${motivo ?? "?"}). Tentando de novo em 5 segundos...`);
      codigoPedido = false;
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
else { numeroPareamento = await perguntarNumero(); await conectar(); }
// Avisa o app que o robô está ligado, mesmo sem mensagens na fila.
setInterval(() => { ciclo().catch((e) => log("Erro:", e.message)); }, INTERVALO);
setInterval(() => { informar(); }, 15000);
informar();
ciclo().catch(() => {});
