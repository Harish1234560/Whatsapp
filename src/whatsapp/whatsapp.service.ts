import type { Env } from '../config/env.js';
import { toWhatsAppNumber } from '../util/phone.js';
import {
  WhatsAppError,
  classifyMetaError,
  type RemoteTemplate,
  type SendResult,
  type SendTemplateInput,
  type WhatsAppProvider,
} from './whatsapp.types.js';

/**
 * The official WhatsApp Business Platform Cloud API. No browser automation,
 * no unofficial senders. Business-initiated messages always use an approved template.
 */
export class CloudWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'cloud' as const;
  private base: string;

  constructor(private env: Pick<Env, 'whatsappToken' | 'whatsappPhoneNumberId' | 'whatsappWabaId' | 'whatsappApiVersion'>) {
    this.base = `https://graph.facebook.com/${env.whatsappApiVersion}`;
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWhatsAppNumber(input.to),
      type: 'template',
      template: {
        name: input.templateName,
        language: { code: input.language },
        components: [
          {
            type: 'body',
            parameters: input.bodyParams.map((text) => ({ type: 'text', text })),
          },
        ],
      },
    });
  }

  async sendText(to: string, body: string): Promise<SendResult> {
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWhatsAppNumber(to),
      type: 'text',
      text: { preview_url: false, body },
    });
  }

  async listTemplates(): Promise<RemoteTemplate[]> {
    if (!this.env.whatsappWabaId) throw new WhatsAppError('AUTH', 'WHATSAPP_WABA_ID is not configured.', false);
    const res = await this.request(`${this.base}/${this.env.whatsappWabaId}/message_templates?fields=name,language,status&limit=200`, { method: 'GET' });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw classifyMetaError(json?.error?.code, res.status, json?.error?.message ?? `HTTP ${res.status}`);
    return (json.data ?? []).map((t: any) => ({ name: t.name, language: t.language, status: t.status }));
  }

  private async post(payload: unknown): Promise<SendResult> {
    const res = await this.request(`${this.base}/${this.env.whatsappPhoneNumberId}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw classifyMetaError(json?.error?.code, res.status, json?.error?.message ?? `HTTP ${res.status}`);
    }
    const messageId = json?.messages?.[0]?.id;
    if (!messageId) throw new WhatsAppError('UNKNOWN', 'The API accepted the request but returned no message id.', false);
    return { messageId };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${this.env.whatsappToken}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // No response at all. We cannot know whether Meta received it, but no message id exists, so a retry is allowed.
      throw new WhatsAppError('NETWORK', `Network error: ${(err as Error).message}`, true);
    }
  }
}
