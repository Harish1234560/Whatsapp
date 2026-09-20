export interface SendTemplateInput {
  /** E.164 with the plus sign. */
  to: string;
  templateName: string;
  language: string;
  bodyParams: string[];
}

export interface SendResult {
  messageId: string;
}

export interface RemoteTemplate {
  name: string;
  language: string;
  status: string;
}

export interface WhatsAppProvider {
  readonly name: 'mock' | 'cloud';
  sendTemplate(input: SendTemplateInput): Promise<SendResult>;
  /** Free text is only allowed inside the 24-hour window after the customer wrote to us. */
  sendText(to: string, body: string): Promise<SendResult>;
  listTemplates?(): Promise<RemoteTemplate[]>;
}

/** Normalised failure reasons shown separately in analytics. */
export type WhatsAppErrorCode =
  | 'NETWORK'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'MARKETING_LIMIT' // Meta's per-user cap on marketing messages. Outside our control.
  | 'NOT_ON_WHATSAPP'
  | 'TEMPLATE_PROBLEM'
  | 'AUTH'
  | 'INVALID_NUMBER'
  | 'UNKNOWN';

export class WhatsAppError extends Error {
  constructor(
    public code: WhatsAppErrorCode,
    message: string,
    /** Only network failures, HTTP 429, and 5xx are safe to retry. */
    public retryable: boolean,
    public rawCode?: number | string,
  ) {
    super(message);
  }
}

/** Map Meta's numeric error codes onto our reasons. */
export function classifyMetaError(rawCode: number | undefined, httpStatus: number, message: string): WhatsAppError {
  switch (rawCode) {
    case 131049:
      return new WhatsAppError('MARKETING_LIMIT', message, false, rawCode);
    case 131026:
      return new WhatsAppError('NOT_ON_WHATSAPP', message, false, rawCode);
    case 131021:
    case 131030:
    case 100:
      return new WhatsAppError('INVALID_NUMBER', message, false, rawCode);
    case 132000:
    case 132001:
    case 132005:
    case 132007:
    case 132012:
    case 132015:
    case 132016:
      return new WhatsAppError('TEMPLATE_PROBLEM', message, false, rawCode);
    case 190:
    case 10:
    case 200:
      return new WhatsAppError('AUTH', message, false, rawCode);
    case 4:
    case 80007:
    case 130429:
    case 131048:
    case 131056:
      return new WhatsAppError('RATE_LIMITED', message, true, rawCode);
    case 131000:
    case 131016:
    case 2:
      return new WhatsAppError('SERVER_ERROR', message, true, rawCode);
  }
  if (httpStatus === 429) return new WhatsAppError('RATE_LIMITED', message, true, rawCode);
  if (httpStatus >= 500) return new WhatsAppError('SERVER_ERROR', message, true, rawCode);
  return new WhatsAppError('UNKNOWN', message, false, rawCode);
}
