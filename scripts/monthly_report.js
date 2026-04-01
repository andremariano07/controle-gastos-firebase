const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const { ChartJSNodeCanvas } = require("chartjs-node-canvas");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const REPORT_UID = process.env.REPORT_UID;
const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const ALERT_PERCENT = Number(process.env.ALERT_PERCENT || 60);

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!TELEGRAM_CHAT_ID) throw new Error("Missing TELEGRAM_CHAT_ID");
if (!FIREBASE_PROJECT_ID) throw new Error("Missing FIREBASE_PROJECT_ID");
if (!REPORT_UID) throw new Error("Missing REPORT_UID");
if (!FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");

const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: FIREBASE_PROJECT_ID,
  });
}

const db = admin.firestore();

function money(v) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(v) || 0);
}

function monthId(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(monthNumber) {
  const labels = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
  return labels[monthNumber - 1] || "";
}

function calc(data = {}) {
  const salario = Number(data.salario || 0);
  const inter = Number(data.cartaoInter ?? data.inter ?? 0);
  const c6 = Number(data.cartaoC6 ?? data.c6 ?? 0);
  const seguro = Number(data.seguroCarro || 0);
  const saldoConta = Number(data.saldoConta || 0);

  const saidas = inter + c6 + seguro;
  const sobra = salario - saidas;
  const saldoFinal = saldoConta + sobra;
  const percentualSaidas = salario > 0 ? (saidas / salario) * 100 : 0;

  return {
    salario,
    inter,
    c6,
    seguro,
    saldoConta,
    saidas,
    sobra,
    saldoFinal,
    percentualSaidas,
  };
}

async function getMonth(uid, id) {
  const doc = await db.doc(`users/${uid}/months/${id}`).get();

  if (!doc.exists) {
    return {
      id,
      exists: false,
      raw: {},
      ...calc({}),
    };
  }

  const data = doc.data() || {};
  return {
    id,
    exists: true,
    raw: data,
    ...calc(data),
  };
}

async function getYearMonths(uid, year) {
  const ids = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const refs = ids.map((id) => db.doc(`users/${uid}/months/${id}`));
  const snaps = await db.getAll(...refs);

  return ids.map((id, idx) => {
    const snap = snaps[idx];
    if (!snap.exists) {
      return {
        id,
        exists: false,
        raw: {},
        ...calc({}),
      };
    }

    const data = snap.data() || {};
    return {
      id,
      exists: true,
      raw: data,
      ...calc(data),
    };
  });
}

async function sendTelegramMessage(text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
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
    throw new Error(`Telegram sendMessage error: ${JSON.stringify(data)}`);
  }
}

async function sendTelegramPhoto(photoPath, caption) {
  const form = new FormData();
  form.append("chat_id", TELEGRAM_CHAT_ID);
  form.append("caption", caption);
  form.append("parse_mode", "HTML");

  const fileBlob = new Blob([fs.readFileSync(photoPath)], { type: "image/png" });
  form.append("photo", fileBlob, path.basename(photoPath));

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: form,
  });

  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram sendPhoto error: ${JSON.stringify(data)}`);
  }
}

function buildAlertText(month) {
  if (!month.exists) {
    return `⚠️ Não encontrei os dados de <b>${month.id}</b>.`;
  }

  if (month.percentualSaidas > ALERT_PERCENT) {
    return `🚨 Alerta: suas saídas em <b>${month.id}</b> consumiram <b>${month.percentualSaidas.toFixed(2)}%</b> do salário, acima do limite de <b>${ALERT_PERCENT}%</b>.`;
  }

  return `✅ Suas saídas em <b>${month.id}</b> ficaram em <b>${month.percentualSaidas.toFixed(2)}%</b> do salário.`;
}

function buildComparisonText(currentMonth, previousMonth) {
  const diff = previousMonth.saidas - currentMonth.saidas;

  if (diff > 0) {
    const pct = previousMonth.saidas > 0 ? ((diff / previousMonth.saidas) * 100).toFixed(2) : "0.00";
    return `✅ Você gastou <b>${money(diff)}</b> a menos que no mês anterior.\n📉 Redução de <b>${pct}%</b>.`;
  }

  if (diff < 0) {
    const increase = Math.abs(diff);
    const pct = previousMonth.saidas > 0 ? ((increase / previousMonth.saidas) * 100).toFixed(2) : "0.00";
    return `⚠️ Você gastou <b>${money(increase)}</b> a mais que no mês anterior.\n📈 Aumento de <b>${pct}%</b>.`;
  }

  return `➖ Você gastou exatamente o mesmo valor que no mês anterior.`;
}

function buildQuickSummary(month) {
  if (!month.exists) {
    return `Sem dados para ${month.id}.`;
  }

  if (month.sobra < 0) {
    return `Suas saídas passaram <b>${money(Math.abs(month.sobra))}</b> do salário; seu saldo final projetado ficou em <b>${money(month.saldoFinal)}</b>.`;
  }

  return `Você terminou o mês com sobra de <b>${money(month.sobra)}</b> e saldo final projetado de <b>${money(month.saldoFinal)}</b>.`;
}

async function generateChart(months, year) {
  const width = 1200;
  const height = 700;
  const chartJSNodeCanvas = new ChartJSNodeCanvas({
    width,
    height,
    backgroundColour: "white",
  });

  const labels = months.map((m) => {
    const monthNumber = Number(m.id.split("-")[1]);
    return monthLabel(monthNumber);
  });

  const salarioData = months.map((m) => m.salario);
  const saidasData = months.map((m) => m.saidas);
  const saldoFinalData = months.map((m) => m.saldoFinal);

  const configuration = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: "Salário",
          data: salarioData,
          backgroundColor: "rgba(54, 162, 235, 0.6)",
          borderColor: "rgba(54, 162, 235, 1)",
          borderWidth: 1,
        },
        {
          type: "bar",
          label: "Saídas (Inter + C6 + Seguro)",
          data: saidasData,
          backgroundColor: "rgba(255, 99, 132, 0.6)",
          borderColor: "rgba(255, 99, 132, 1)",
          borderWidth: 1,
        },
        {
          type: "line",
          label: "Saldo Final Projetado",
          data: saldoFinalData,
          borderColor: "rgba(255, 159, 64, 1)",
          backgroundColor: "rgba(255, 159, 64, 0.2)",
          borderWidth: 3,
          tension: 0.25,
          fill: false,
          yAxisID: "y",
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: `Gráfico ${year}`,
          font: {
            size: 24,
          },
        },
        legend: {
          position: "bottom",
          labels: {
            font: {
              size: 16,
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            font: {
              size: 14,
            },
          },
        },
        y: {
          ticks: {
            font: {
              size: 14,
              callback: (value) =>
                new Intl.NumberFormat("pt-BR", {
                  style: "currency",
                  currency: "BRL",
                  maximumFractionDigits: 0,
                }).format(value),
            },
          },
        },
      },
    },
  };

  const buffer = await chartJSNodeCanvas.renderToBuffer(configuration);
  const outputPath = path.join(process.cwd(), `grafico-${year}.png`);
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

async function main() {
  const now = new Date();

  const closedMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const previousMonthDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);

  const closedMonthId = monthId(closedMonthDate);
  const previousMonthId = monthId(previousMonthDate);

  const closedMonth = await getMonth(REPORT_UID, closedMonthId);
  const previousMonth = await getMonth(REPORT_UID, previousMonthId);

  const year = closedMonthDate.getFullYear();
  const yearMonths = await getYearMonths(REPORT_UID, year);

  const comparisonText = buildComparisonText(closedMonth, previousMonth);
  const alertText = buildAlertText(closedMonth);
  const quickSummary = buildQuickSummary(closedMonth);

  const message =
`📊 <b>Relatório Mensal</b>

🗓 <b>${closedMonthId}</b>
• Salário: <b>${money(closedMonth.salario)}</b>
• Inter: ${money(closedMonth.inter)}
• C6: ${money(closedMonth.c6)}
• Seguro: ${money(closedMonth.seguro)}
• Total saídas: <b>${money(closedMonth.saidas)}</b>
• Sobra do salário: <b>${money(closedMonth.sobra)}</b>
• Saldo final projetado: <b>${money(closedMonth.saldoFinal)}</b>

🗓 <b>${previousMonthId}</b>
• Total saídas: <b>${money(previousMonth.saidas)}</b>

<b>Resumo rápido</b>
${quickSummary}

${comparisonText}

${alertText}

${!closedMonth.exists ? `\n⚠️ Não encontrei o documento do mês <b>${closedMonthId}</b>.` : ""}
${!previousMonth.exists ? `\n⚠️ Não encontrei o documento do mês <b>${previousMonthId}</b>.` : ""}`.trim();

  await sendTelegramMessage(message);

  const chartPath = await generateChart(yearMonths, year);

  await sendTelegramPhoto(
    chartPath,
    `📈 <b>Gráfico ${year}</b>\nSalário, saídas e saldo final projetado.`
  );

  console.log("OK: relatório e gráfico enviados.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
