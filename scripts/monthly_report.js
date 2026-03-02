const admin = require("firebase-admin");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const REPORT_UID = process.env.REPORT_UID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error("Missing Telegram secrets");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!FIREBASE_PROJECT_ID) throw new Error("Missing FIREBASE_PROJECT_ID");
if (!REPORT_UID) throw new Error("Missing REPORT_UID");

const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
if (!svc.client_email) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");

admin.initializeApp({
  credential: admin.credential.cert(svc),
  projectId: FIREBASE_PROJECT_ID,
});
const db = admin.firestore();

function monthIdFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
function previousMonthId(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return monthIdFromDate(d);
}
function normalize(d = {}) {
  const salario = Number(d.salario || 0);
  const inter = Number(d.cartaoInter ?? d.inter ?? 0);
  const c6 = Number(d.cartaoC6 ?? d.c6 ?? 0);
  const seguro = Number(d.seguroCarro || 0);
  const saldoConta = Number(d.saldoConta || 0);
  const saidas = inter + c6 + seguro;
  const sobra = salario - saidas;
  const saldoFinal = saldoConta + sobra;
  return { salario, inter, c6, seguro, saldoConta, saidas, sobra, saldoFinal };
}
const sum = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0);

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
  if (!res.ok) throw new Error(`Telegram error ${res.status}: ${await res.text()}`);
}

async function callOpenAI(prompt) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-5.2",
      input: [
        {
          role: "system",
          content:
            "Você é um analista financeiro pessoal. Escreva em pt-BR, direto, com bullets. " +
            "Não invente dados. Dê alertas e ações práticas.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text =
    data.output_text ||
    data.output?.map(x => x.content?.map(c => c.text).join("")).join("\n") ||
    "";
  return String(text).trim();
}

(async () => {
  const monthId = previousMonthId(new Date()); // mês que fechou
  const year = Number(monthId.slice(0, 4));

  // Lê os 12 meses do ano
  const monthIds = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const refs = monthIds.map(id => db.doc(`users/${REPORT_UID}/months/${id}`));
  const snaps = await db.getAll(...refs);

  const months = monthIds.map((id, idx) => {
    const snap = snaps[idx];
    const data = snap.exists ? snap.data() : {};
    return { id, ...normalize(data) };
  });

  // Só considera até o mês fechado
  const closed = months.filter(m => m.id <= monthId);

  // Envia “mês a mês” (1 mensagem por mês)
  for (const m of closed) {
    const pct = m.salario > 0 ? (m.saidas / m.salario) * 100 : 0;

    const prompt =
`Crie um relatório curto para Telegram do mês ${m.id} com:
- Resumo (salário, saídas, sobra, saldo final projetado)
- 1 alerta se necessário (sobra negativa, ou saídas muito altas)
- 2 ações práticas (bem diretas)

Dados:
salario=${m.salario}
saidas=${m.saidas}
inter=${m.inter}
c6=${m.c6}
seguro=${m.seguro}
sobra=${m.sobra}
saldoConta=${m.saldoConta}
saldoFinal=${m.saldoFinal}
pctSaidasDoSalario=${pct}`;

    const ai = await callOpenAI(prompt);
    await sendTelegram(`📅 <b>Mês ${m.id}</b>\n\n${ai}`);
  }

  // Resumo do ano (acumulado)
  const salarioYTD = sum(closed.map(x => x.salario));
  const saidasYTD = sum(closed.map(x => x.saidas));
  const sobraYTD = salarioYTD - saidasYTD;

  const top = [...closed].sort((a,b) => b.saidas - a.saidas).slice(0,3);

  const promptYear =
`Faça um resumo anual (até ${monthId}) para Telegram com:
- total salários, total saídas, sobra acumulada
- top 3 meses mais caros por saídas
- 3 sugestões pro próximo mês

Dados:
salarioYTD=${salarioYTD}
saidasYTD=${saidasYTD}
sobraYTD=${sobraYTD}
top3=${top.map(x => `${x.id}:${x.saidas}`).join(", ")}`;

  const aiYear = await callOpenAI(promptYear);
  await sendTelegram(`📌 <b>Acumulado ${year} (até ${monthId})</b>\n\n${aiYear}`);

  console.log("OK: relatórios enviados.");
})();
