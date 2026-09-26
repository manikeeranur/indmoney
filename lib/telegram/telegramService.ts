// ─── Telegram sender (core) ────────────────────────────────────────────────────
// Ported from backend/src/services/telegramService.js, including the
// sendDocument/chat-id-override additions built for the Kite app's EOD OHLC
// report. BOT_TOKEN/CHAT_ID are read lazily (not at module load) so a login
// that sets env vars via a running process still works without a restart —
// same reasoning as lib/broker/auth.ts reading credentials through functions.
import { LOT_SIZE, NUM_LOTS } from "@/lib/strategies/constants";

const ORDER_QTY = LOT_SIZE * NUM_LOTS;

function BOT_TOKEN() { return process.env.TELEGRAM_BOT_TOKEN || ""; }
function CHAT_ID()   { return process.env.TELEGRAM_CHAT_ID   || ""; }
export function CHAT_ID_OI_SNIPER() { return process.env.TELEGRAM_CHAT_ID_OI_SNIPER || ""; }

export function isConfigured(chatId: string = CHAT_ID()): boolean {
  return BOT_TOKEN().length > 10 && String(chatId).length > 3;
}

export async function post(text: string, chatId: string = CHAT_ID()): Promise<void> {
  if (!isConfigured(chatId)) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch { /* best-effort — a failed Telegram send must never break trading */ }
}

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export async function postChunked(lines: string[], chatId: string = CHAT_ID()): Promise<void> {
  const MAX = 4000;
  let chunk = "";
  for (const line of lines) {
    if ((chunk + "\n" + line).length > MAX) {
      await post(chunk.trim(), chatId);
      await delay(400);
      chunk = line;
    } else {
      chunk = chunk ? chunk + "\n" + line : line;
    }
  }
  if (chunk.trim()) await post(chunk.trim(), chatId);
}

export async function sendDocument(
  buffer: Buffer, filename: string, caption = "",
  opts: { chatId?: string; contentType?: string } = {},
): Promise<boolean> {
  const chatId = opts.chatId ?? CHAT_ID();
  const contentType = opts.contentType ?? "text/csv";
  if (!isConfigured(chatId)) return false;
  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    if (caption) {
      form.append("caption", caption.slice(0, 1024));
      form.append("parse_mode", "HTML");
    }
    form.append("document", new Blob([new Uint8Array(buffer)], { type: contentType }), filename);

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/sendDocument`, { method: "POST", body: form });
    const json: any = await res.json().catch(() => ({}));
    if (!json.ok) {
      console.error(`[Telegram] sendDocument failed (${filename}):`, json.description || res.status);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error(`[Telegram] sendDocument error (${filename}):`, err.message);
    return false;
  }
}

export function exitReason(status: string): string {
  return status === "TARGET"        ? "Target Hit"
    :    status === "SL"            ? "SL Hit"
    :    status === "TIME_EXIT"     ? "3:20 PM Square-off"
    :    status === "EOD"           ? "End of Day"
    :    status === "STAGNANT_EXIT" ? "Stagnant — No Movement"
    :    status;
}

export { ORDER_QTY };

export function sendStartupPing() {
  const time = new Date().toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" });
  post([
    `🚀 <b>INDMONEY Algo — Online</b>`,
    ``,
    `✅ Bot connected`,
    `🕐 Server time : ${time} IST`,
    `📊 SMC + VWAP 9:30 strategies active`,
  ].join("\n"));
}

export function sendSessionOpen() {
  const date = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  post([`🔔 <b>LIVE SESSION STARTED</b>`, ``, `📅 Date   : ${date}`, `🕐 Time   : 09:15 IST`, ``, `<i>Market is open. Watching for signals...</i>`].join("\n"));
}

export function sendSessionClose() {
  const date = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  post([`🔕 <b>LIVE SESSION ENDING</b>`, ``, `📅 Date   : ${date}`, `🕐 Time   : 15:30 IST`, ``, `<i>Market is closing. No new entries will be taken.</i>`].join("\n"));
}
