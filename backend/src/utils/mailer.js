import nodemailer from 'nodemailer';

// 🟢 SMTP transporter — configure via env vars:
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE ('true'/'false'), SMTP_USER, SMTP_PASS, EMAIL_FROM
// For Gmail: SMTP_HOST=smtp.gmail.com, SMTP_PORT=587, SMTP_SECURE=false,
// SMTP_USER=you@gmail.com, SMTP_PASS=<app password, not your login password>.
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true', // true for port 465, false for 587/25
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM = process.env.EMAIL_FROM || process.env.SMTP_USER;

// Generic sender — never throws. Logs and returns { sent: false } instead, so a
// down SMTP server never turns into a 500 on whatever action triggered the email
// (e.g. checkInactivity should still finish flagging employees even if mail fails).
export async function sendEmail({ to, subject, html, text }) {
  if (!to) {
    console.error('sendEmail: no recipient provided, skipping', { subject });
    return { sent: false, reason: 'no_recipient' };
  }
  try {
    await transporter.sendMail({
      from: FROM,
      to,
      subject,
      html,
      text: text || html?.replace(/<[^>]+>/g, ''),
    });
    return { sent: true };
  } catch (err) {
    console.error('sendEmail failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

// ── Shared branded layout ──
// Table-based HTML (not flexbox/divs) so it renders consistently across
// Gmail, Outlook desktop, and other clients with poor modern-CSS support.
function renderEmailLayout({ heading, bodyHtml, accentColor = '#3b82f6', calloutHtml = '' }) {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6; padding:32px 0; font-family:Arial,Helvetica,sans-serif;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:8px; overflow:hidden; max-width:600px;">
          <tr>
            <td style="background:${accentColor}; padding:20px 32px;">
              <span style="font-size:20px; font-weight:bold; color:#ffffff;">AttendTrack</span>
              <div style="font-size:12px; color:#e5e7eb; margin-top:2px;">Workforce Management</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h2 style="margin:0 0 16px; font-size:18px; color:#111827;">${heading}</h2>
              <div style="font-size:14px; line-height:1.6; color:#374151;">${bodyHtml}</div>
              ${calloutHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px; background:#f9fafb; border-top:1px solid #e5e7eb;">
              <div style="font-size:12px; color:#9ca3af;">This is an automated notification from the AttendTrack Workforce Management System.</div>
              <div style="font-size:12px; color:#9ca3af; margin-top:4px;">© ${new Date().getFullYear()} AttendTrack. All rights reserved.</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

// ── Templated senders ──

export async function sendInactivityEmail(employee, { daysSinceAttendance, lastAttendanceDate } = {}) {
  const formattedDate = lastAttendanceDate
    ? new Date(lastAttendanceDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  const body = lastAttendanceDate
    ? `Our records indicate that you have not recorded any attendance for the past ${daysSinceAttendance} consecutive working days. Your last recorded attendance was on ${formattedDate}.`
    : `Our records indicate that you have no attendance records on file at all.`;

  const html = renderEmailLayout({
    heading: 'Attendance Status Notification',
    accentColor: '#dc2626',
    bodyHtml: `
      <p style="margin:0 0 12px;">Hello, ${employee.name},</p>
      <p style="margin:0 0 12px;">${body}</p>
      <p style="margin:0 0 12px;">If you believe this action was taken in error, please contact the Human Resources or Administration team so that we can review your records.</p>
      <p style="margin:16px 0 0;">Thank you,<br/>Workforce Management Team</p>
    `,
    calloutHtml: `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
        <tr>
          <td style="background:#fef2f2; border:1px solid #fecaca; border-radius:6px; padding:12px 16px;">
            <span style="font-size:13px; color:#991b1b; font-weight:bold;">Status: Inactive</span>
          </td>
        </tr>
      </table>
    `,
  });

  return sendEmail({ to: employee.email, subject: 'Attendance Status Notification', html });
}

export async function sendLeaveApprovedEmail({ to, employeeName, type, startDate, endDate }) {
  const html = renderEmailLayout({
    heading: 'Leave Approved',
    accentColor: '#16a34a',
    bodyHtml: `
      <p style="margin:0 0 12px;">Hi,</p>
      <p style="margin:0 0 12px;"><strong>${employeeName}</strong>'s ${type} leave request has been approved, covering <strong>${startDate}</strong> to <strong>${endDate}</strong>.</p>
      <p style="margin:0;">Please arrange coverage/exchange for this period if needed.</p>
    `,
    calloutHtml: `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
        <tr>
          <td style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px; padding:12px 16px;">
            <span style="font-size:13px; color:#166534; font-weight:bold;">Status: Approved</span>
          </td>
        </tr>
      </table>
    `,
  });

  return sendEmail({ to, subject: `AttendTrack: Leave approved for ${employeeName}`, html });
}