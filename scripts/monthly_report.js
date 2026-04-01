const admin = require("firebase-admin");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const REPORT_UID = process.env.REPORT_UID;
const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  throw new Error("Missing Telegram secrets");
}
if (!FIREBASE_PROJECT_ID) {
  throw new Error("Missing FIREBASE_PROJECT_ID");
}
if (!REPORT_UID) {
  throw new Error("Missing REPORT_UID");
}
if (!FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");
}

const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: FIREBASE_PROJECT_ID,
  });
}

const db = admin.firestore();

function formatMoney(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(value) || 0);
}

function monthIdFromDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function getLastMonthId(now = new Date()) {
  return monthIdFromDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
}

function getPreviousMonthId(now = new Date()) {
  return monthIdFromDate(new Date(now.getFullYear(), now.getMonth() - 2, 1));
}

function normalizeMonthData(data = {}) {
  const salario = Number(data.salario || 0);
  const inter = Number(data.cartaoInter ?? data.inter ?? 0);
  const c6 = Number(data.cartaoC6 ?? data.c6 ?? 0);
  const seguro = Number(data.seguroCarro || 0);
  const saldoConta = Number(data.saldoConta || 0);

  const saidas = inter + c6 + seguro;
  const sobra = salario - saidas;
  const saldoFinal = saldoConta + sobra;

  return {
    salario,
    inter,
    c6,
    seguro,
    saldoConta,
    saidas,
    sobra,
    saldoFinal,
  };
}

async function getMonthData(uid, monthId) {
  const ref = db.doc(`users/${uid}/months/${monthId}`);
  const snap = await ref.get();

  if (!snap.exists) {
    return {
      monthId,
      exists: false,
      raw: {},
      ...normalizeMonthData({}),
    };
  }

  const raw = snap.data() || {};
  return {
    monthId,
    exists: true,
    raw,
    ...normalizeMonthData(raw),
  };
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(`Telegram error: ${JSON.stringify(data)}`);
  }
}

async function main() {
  const now = new Date();
  const lastMonthId = getLastMonthId(now);
  const previousMonthId = getPreviousMonthId(now);

  const lastMonth = await getMonthData(REPORT_UID, lastMonthId);
  const previousMonth = await getMonthData(REPORT_UID, previousMonthId);

  const diff = previousMonth.saidas - lastMonth.saidas;

  let comparisonText = "";
  if (diff > 0) {
    const pct = previousMonth.saidas > 0
      ? ((diff / previousMonth.saidas) * 100).toFixed(2)
      : "0.00";
    comparisonText =
      `✅ Você gastou <b>${formatMoney(diff)}</b> a menos que no mês anterior.\n` +
      `📉 Redução de <b>${pct}%</b>.`;
  } else if (diff < 0) {
    const increase = Math.abs(diff);
    const pct = previousMonth.saidas > 0
      ? ((increase / previousMonth.saidas) * 100).toFixed(2)
      : "0.00";
    comparisonText =
      `⚠️ Você gastou <b>${formatMoney(increase)}</b> a mais que no mês anterior.\n` +
      `📈 Aumento de <b>${pct}%</b>.`;
  } else {
    comparisonText = `➖ Você gastou exatamente o mesmo valor que no mês anterior.`;
  }

  const warnLast = !lastMonth.exists
    ? `\n⚠️ Não encontrei o documento do mês <b>${lastMonthId}</b>.`
    : "";

  const warnPrev = !previousMonth.exists
    ? `\n⚠️ Não encontrei o documento do mês <b>${previousMonthId}</b>.`
    : "";

  const message =
`📊 <b>Relatório Mensal de Gastos</b>

🗓 <b>${lastMonthId}</b>
• Saídas: <b>${formatMoney(lastMonth.saidas)}</b>
• Inter: ${formatMoney(lastMonth.inter)}
• C6: ${formatMoney(lastMonth.c6)}
• Seguro: ${formatMoney(lastMonth.seguro)}

🗓 <b>${previousMonthId}</b>
• Saídas: <b>${formatMoney(previousMonth.saidas)}</b>
• Inter: ${formatMoney(previousMonth.inter)}
• C6: ${formatMoney(previousMonth.c6)}
• Seguro: ${formatMoney(previousMonth.seguro)}

${comparisonText}${warnLast}${warnPrev}`;

  await sendTelegram(message);
  console.log("OK: relatório enviado.");
  console.log("Mês atual fechado:", lastMonthId, lastMonth.raw);
  console.log("Mês anterior:", previousMonthId, previousMonth.raw);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
