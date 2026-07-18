const HR1_WEBHOOK_URL = process.env.HR1_WEBHOOK_URL || null;

// Notifies HR1 that a driver was flagged inactive. Never throws — a failed
// or unconfigured webhook should not stop the inactivity check from
// completing or logging the event.
export async function notifyHr1(driver, reasons, details) {
  if (!HR1_WEBHOOK_URL) {
    return { hr1Notified: false, hr1Response: 'HR1_WEBHOOK_URL not configured — skipped' };
  }

  try {
    const resp = await fetch(HR1_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'driver_inactive',
        driver: {
          id: driver.id,
          name: driver.name,
          driver_id: driver.driver_id,
        },
        reasons,
        details,
        detected_at: new Date().toISOString(),
      }),
    });
    return { hr1Notified: resp.ok, hr1Response: `HTTP ${resp.status}` };
  } catch (err) {
    return { hr1Notified: false, hr1Response: `Webhook error: ${err.message}` };
  }
}
