const admin = require("firebase-admin");

// ENV
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const REPORT_UID = process.env.REPORT_UID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)
  throw new Error("Erro: Telegram não configurado");

if (!FIREBASE_PROJECT_ID || !REPORT_UID)
  throw new Error("Erro: Firebase não configurado");

// Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");

if (!serviceAccount.client_email)
  throw new Error("Erro: FIREBASE_SERVICE_ACCOUNT_JSON inválido");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: FIREBASE_PROJECT_ID,
});

const db = admin.firestore();

// Função para pegar mês
function getMonthRange(year, month) {
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  return { start, end };
}

// Soma despesas
async function getTotal(uid, year, month) {
  const { start, end } = getMonthRange(year, month);

  const snapshot = await db
    .collection("usuarios")
    .doc(uid)
    .collection("transacoes")
    .where("data", ">=", admin.firestore.Timestamp.fromDate(start))
    .where("data", "<", admin.firestore.Timestamp.fromDate(end))
    .get();

  let total = 0;

  snapshot.forEach((doc) => {
    const d = doc.data();

    const valor = Number(d.valor || 0);
    const tipo = String(d.tipo || "").toLowerCase();

    if (tipo === "despesa") {
      total += valor;
    }
  });

  return total;
}

// Telegram
async function sendTelegram(text) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
    }
  );

  const data = await res.json();

  if (!data.ok) {
    throw new Error("Erro Telegram: " + JSON.stringify(data));
  }
}

// Formatar dinheiro
function money(v) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(v);
}

// MAIN
async function main() {
  const now = new Date();

  // mês passado
  const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  // mês anterior
  const prevMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));

  const totalLast = await getTotal(
    REPORT_UID,
    lastMonthDate.getUTCFullYear(),
    lastMonthDate.getUTCMonth()
  );

  const totalPrev = await getTotal(
    REPORT_UID,
    prevMonthDate.getUTCFullYear(),
    prevMonthDate.getUTCMonth()
  );

  const diff = totalPrev - totalLast;

  let resultado = "";

  if (diff > 0) {
    const percent = totalPrev > 0 ? ((diff / totalPrev) * 100).toFixed(2) : "0.00";
    resultado = `✅ Você gastou <b>${money(diff)}</b> a menos\n📉 Redução de <b>${percent}%</b>`;
  } else if (diff < 0) {
    const aumento = Math.abs(diff);
    const percent = totalPrev > 0 ? ((aumento / totalPrev) * 100).toFixed(2) : "0.00";
    resultado = `⚠️ Você gastou <b>${money(aumento)}</b> a mais\n📈 Aumento de <b>${percent}%</b>`;
  } else {
    resultado = `➖ Você gastou exatamente o mesmo valor`;
  }

  const mesAtual = lastMonthDate.toLocaleString("pt-BR", {
    month: "long",
    year: "numeric",
  });

  const mesAnterior = prevMonthDate.toLocaleString("pt-BR", {
    month: "long",
    year: "numeric",
  });

  const mensagem =
`📊 <b>Relatório de Gastos</b>

🗓 ${mesAtual}: ${money(totalLast)}
🗓 ${mesAnterior}: ${money(totalPrev)}

${resultado}`;

  await sendTelegram(mensagem);

  console.log("Relatório enviado!");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
