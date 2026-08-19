/** Email SMTP — nodemailer (T-065), fallback to mock */
import nodemailer from "nodemailer";

const host = process.env.SMTP_HOST;
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const port = Number(process.env.SMTP_PORT || 587);

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!host) return null;
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  });
  return transporter;
}

export async function sendEmailSmtp(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  const t = getTransporter();
  if (!t) {
    const { sendEmail } = await import("./email.js");
    await sendEmail({ to, subject, text, html });
    return false;
  }
  try {
    await t.sendMail({ from: process.env.SMTP_FROM || "no-reply@casino.local", to, subject, text, html });
    console.log(`[email smtp] sent to ${to} subject ${subject}`);
    return true;
  } catch (e) {
    console.error("[email smtp] failed", e);
    const { sendEmail } = await import("./email.js");
    await sendEmail({ to, subject, text, html });
    return false;
  }
}
