/**
 * Normalise a stored phone number to E.164. Default country is India (+91).
 * Returns null when the number cannot be trusted; such customers are skipped and logged.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const hadPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (hadPlus) {
    if (digits.startsWith('91')) return isIndianMobile(digits.slice(2)) ? `+${digits}` : null;
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);

  return isIndianMobile(digits) ? `+91${digits}` : null;
}

function isIndianMobile(d: string): boolean {
  return /^[6-9]\d{9}$/.test(d);
}

/** The WhatsApp Cloud API expects the number without the plus sign. */
export function toWhatsAppNumber(e164: string): string {
  return e164.replace(/^\+/, '');
}

export function last10(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10);
}
