import crypto from 'node:crypto';
import { WhatsAppError, type RemoteTemplate, type SendResult, type SendTemplateInput, type WhatsAppProvider } from './whatsapp.types.js';

export interface MockSend {
  kind: 'template' | 'text';
  to: string;
  templateName?: string;
  bodyParams?: string[];
  body?: string;
  messageId: string;
}

/**
 * Stand-in for the WhatsApp Cloud API. Records every send so tests can assert
 * on exactly what would have gone out. Refused in production by config validation.
 */
export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'mock' as const;
  readonly sent: MockSend[] = [];
  private failures: WhatsAppError[] = [];
  /** Dev server hook: simulate delivered/read webhooks after a send. */
  onSent?: (send: MockSend) => void;

  /** Queue an error for the next send. */
  failNext(err: WhatsAppError): void {
    this.failures.push(err);
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    const planned = this.failures.shift();
    if (planned) throw planned;
    // Convention for manual testing: numbers ending in 0000 are "not on WhatsApp".
    if (input.to.endsWith('0000')) throw new WhatsAppError('NOT_ON_WHATSAPP', 'Mock: recipient is not on WhatsApp.', false, 131026);

    const send: MockSend = {
      kind: 'template',
      to: input.to,
      templateName: input.templateName,
      bodyParams: input.bodyParams,
      messageId: `wamid.mock.${crypto.randomUUID()}`,
    };
    this.sent.push(send);
    this.onSent?.(send);
    return { messageId: send.messageId };
  }

  async sendText(to: string, body: string): Promise<SendResult> {
    const send: MockSend = { kind: 'text', to, body, messageId: `wamid.mock.${crypto.randomUUID()}` };
    this.sent.push(send);
    return { messageId: send.messageId };
  }

  async listTemplates(): Promise<RemoteTemplate[]> {
    return [];
  }

  templatesSentTo(to: string): MockSend[] {
    return this.sent.filter((s) => s.kind === 'template' && s.to === to);
  }
}
