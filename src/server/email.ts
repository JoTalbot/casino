/** Email mock — логирует в консоль и в файл (T-056) */
import { appendFile } from "node:fs/promises";

const LOG_PATH = process.env.EMAIL_LOG_PATH || "logs/email.log";

export interface Email {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(email: Email): Promise<void> {
  const entry = `[${new Date().toISOString()}] To: ${email.to} | Subject: ${email.subject}\n${email.text}\n${email.html ? `HTML: ${email.html.slice(0,200)}...\n` : ""}---\n`;
  console.log(`[email mock] ${entry}`);
  try {
    await appendFile(LOG_PATH, entry, "utf8");
  } catch {
    // ignore if logs dir missing
  }
}

export async function sendWelcomeEmail(username: string, email?: string): Promise<void> {
  if (!email) return;
  await sendEmail({
    to: email,
    subject: `Добро пожаловать, ${username}!`,
    text: `Привет, ${username}! Твой баланс 100 000 CHIP ждёт. Играй ответственно, RTP 95.98%.`,
  });
}

export async function sendRealityCheckEmail(username: string, email: string, message: string): Promise<void> {
  await sendEmail({
    to: email,
    subject: "Напоминание о времени в игре",
    text: message,
  });
}
