/**
 * Map of Twilio error codes encountered with WhatsApp Business API
 * to user-friendly messages. Returned to the frontend when an outbound
 * send fails so the UI can show something useful.
 *
 * Codes that AREN'T in this map fall back to a generic message; the raw
 * code is always preserved on the Message row.
 */

export const TWILIO_ERROR_MESSAGES: Record<string, string> = {
  '63016': 'You can only send free-form messages within 24 hours of the customer\'s last message. Use a template to start the conversation.',
  '63018': 'Sending too quickly. Please wait a moment and try again.',
  '63019': 'WhatsApp could not accept this media. Check the size (images ≤5MB, video ≤16MB) and use a supported format (JPG, PNG, MP4, PDF) — SVG is not supported.',
  '63017': 'This recipient has blocked your WhatsApp number.',
  '63003': 'WhatsApp could not deliver this message (channel unavailable).',
  '63013': 'The message was rejected as spam-like content. Edit and retry.',
  '63015': 'WhatsApp is not available for this number.',
  '21408': 'The recipient number is not a valid WhatsApp number.',
  '21610': 'The recipient has opted out and cannot be contacted.',
  '21611': 'This number cannot receive messages right now. Try again later.',
  '21617': 'Message is too long for WhatsApp.',
  '63007': 'The Twilio number is not configured for WhatsApp.',
  '63021': 'Template not approved or not available for this account.',
  '11200': 'Webhook timeout — Twilio could not reach the server.',
};

export function twilioErrorMessage(code: string | null | undefined): string {
  if (!code) return 'Message could not be sent. Please try again.';
  return TWILIO_ERROR_MESSAGES[code] ?? `Message could not be sent (Twilio error ${code}).`;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
