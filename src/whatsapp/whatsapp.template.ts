import type { Queryable } from '../db/db.js';
import type { CampaignType } from '../types.js';

/**
 * WhatsApp marketing messages are fixed texts approved by Meta in advance.
 * Only the numbered variables change per customer. The bodies below are what
 * you submit in WhatsApp Manager, under the Marketing category, with the same
 * template names. Sending is blocked until a template is marked APPROVED.
 */
export type TemplateVariable = 'customer_name' | 'discount_text' | 'coupon_code' | 'expiry_date' | 'festival_name';

export interface Template {
  name: string;
  campaignType: CampaignType;
  language: string;
  body: string;
  variables: TemplateVariable[];
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED';
}

export const DEFAULT_TEMPLATES: Omit<Template, 'approvalStatus'>[] = [
  {
    name: 'birthday_offer',
    campaignType: 'BIRTHDAY',
    language: 'en',
    variables: ['customer_name', 'discount_text', 'coupon_code', 'expiry_date'],
    body:
      '🎂 Happy Birthday {{1}}! 🎉\n\nWe have a special birthday gift for you!\n\nEnjoy {{2}} OFF on your next purchase.\n\n🎟️ Coupon: {{3}}\n\nValid until {{4}}.\n\nHave a wonderful birthday! ❤️\n\nReply STOP to unsubscribe.',
  },
  {
    name: 'festival_offer',
    campaignType: 'FESTIVAL',
    language: 'en',
    variables: ['festival_name', 'customer_name', 'discount_text', 'coupon_code', 'expiry_date'],
    body:
      '🎉 Happy {{1}}, {{2}}!\n\nCelebrate this festive season with us!\n\nEnjoy {{3}} OFF on your next purchase.\n\n🎟️ Coupon: {{4}}\n\nValid until {{5}}.\n\nHappy shopping! ❤️\n\nReply STOP to unsubscribe.',
  },
  {
    name: 'top10_reward',
    campaignType: 'MONTH_END_TOP10',
    language: 'en',
    variables: ['customer_name', 'discount_text', 'coupon_code', 'expiry_date'],
    body:
      '🏆 Hi {{1}}!\n\nThank you for being one of our Top 10 customers this month! 🎉\n\nAs a special thank-you, enjoy {{2}} OFF on your next purchase.\n\n🎟️ Coupon: {{3}}\n\nValid until {{4}}.\n\nThank you for shopping with us! ❤️\n\nReply STOP to unsubscribe.',
  },
];

function mapTemplate(r: any): Template {
  return {
    name: r.name,
    campaignType: r.campaign_type,
    language: r.language,
    body: r.body,
    variables: r.variables,
    approvalStatus: r.approval_status,
  };
}

export async function ensureDefaultTemplates(db: Queryable, approve = false): Promise<void> {
  for (const t of DEFAULT_TEMPLATES) {
    await db.query(
      `INSERT INTO marketing.templates (name, campaign_type, language, body, variables, approval_status)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (name) DO NOTHING`,
      [t.name, t.campaignType, t.language, t.body, JSON.stringify(t.variables), approve ? 'APPROVED' : 'PENDING'],
    );
  }
}

export async function listTemplates(db: Queryable): Promise<Template[]> {
  return (await db.query('SELECT * FROM marketing.templates ORDER BY name')).rows.map(mapTemplate);
}

export async function getTemplate(db: Queryable, name: string): Promise<Template | null> {
  const r = await db.query('SELECT * FROM marketing.templates WHERE name = $1', [name]);
  return r.rows[0] ? mapTemplate(r.rows[0]) : null;
}

export type TemplateValues = Partial<Record<TemplateVariable, string>>;

/** Ordered parameter list for the API call. Missing values are an error, never a blank. */
export function buildParams(t: Template, values: TemplateValues): string[] {
  return t.variables.map((v) => {
    const val = values[v];
    if (val === undefined || val === null || String(val).trim() === '') {
      throw new Error(`Template "${t.name}" needs a value for "${v}".`);
    }
    // Meta rejects parameters containing newlines, tabs, or runs of 4+ spaces.
    return String(val).replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
  });
}

/** Exactly what the customer will read. Used for the admin preview and the history. */
export function renderBody(t: Template, params: string[]): string {
  return t.body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '');
}
