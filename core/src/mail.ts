import nodemailer from 'nodemailer'

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>
}

// null when no SMTP is configured — callers gate on this (a mailer-less
// instance refuses email-account routes rather than creating limbo accounts).
export function createMailer(smtpUrl: string | null, from: string): Mailer | null {
  if (!smtpUrl) return null
  const transport = nodemailer.createTransport(smtpUrl) // parses smtp:// and smtps:// (auth, port, TLS) from the URL
  return {
    async send(to, subject, text) {
      await transport.sendMail({ from, to, subject, text })
    },
  }
}
