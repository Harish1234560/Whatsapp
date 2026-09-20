export type CampaignType = 'BIRTHDAY' | 'FESTIVAL' | 'MONTH_END_TOP10';
export type CampaignStatus = 'DRAFT' | 'GENERATING' | 'PENDING_APPROVAL' | 'APPROVED' | 'SENDING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
export type DiscountType = 'FLAT' | 'PERCENT';
export type CouponStatus = 'ACTIVE' | 'USED' | 'EXPIRED' | 'CANCELLED';
export type MessageStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'SKIPPED';

export interface Campaign {
  id: number;
  name: string;
  type: CampaignType;
  status: CampaignStatus;
  festivalName: string | null;
  startDate: string | null;
  endDate: string | null;
  targetMonth: string | null;
  campaignYear: number | null;
  discountType: DiscountType;
  discountValue: number;
  minimumOrderAmount: number | null;
  maximumDiscount: number | null;
  couponMode: 'PER_CUSTOMER' | 'SHARED';
  sharedCouponCode: string | null;
  sharedUsageCap: number | null;
  couponPrefix: string;
  validFrom: Date | null;
  validUntil: Date | null;
  templateName: string;
  backfill: boolean;
  targetCount: number;
  generationSummary: Record<string, unknown> | null;
  error: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function mapCampaign(r: any): Campaign {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    status: r.status,
    festivalName: r.festival_name,
    startDate: r.start_date,
    endDate: r.end_date,
    targetMonth: r.target_month,
    campaignYear: r.campaign_year,
    discountType: r.discount_type,
    discountValue: Number(r.discount_value),
    minimumOrderAmount: num(r.minimum_order_amount),
    maximumDiscount: num(r.maximum_discount),
    couponMode: r.coupon_mode,
    sharedCouponCode: r.shared_coupon_code,
    sharedUsageCap: r.shared_usage_cap,
    couponPrefix: r.coupon_prefix,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    templateName: r.template_name,
    backfill: r.backfill,
    targetCount: r.target_count,
    generationSummary: r.generation_summary ?? null,
    error: r.error,
    createdBy: r.created_by,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface Coupon {
  id: number;
  code: string;
  customerId: string | null;
  campaignId: number;
  discountType: DiscountType;
  discountValue: number;
  minimumOrderAmount: number | null;
  maximumDiscount: number | null;
  validFrom: Date;
  validUntil: Date;
  usageLimit: number;
  usedCount: number;
  status: CouponStatus;
  usedAt: Date | null;
  usedOrderId: string | null;
  inStoreTable: boolean;
  createdAt: Date;
}

export function mapCoupon(r: any): Coupon {
  return {
    id: r.id,
    code: r.code,
    customerId: r.customer_id,
    campaignId: r.campaign_id,
    discountType: r.discount_type,
    discountValue: Number(r.discount_value),
    minimumOrderAmount: num(r.minimum_order_amount),
    maximumDiscount: num(r.maximum_discount),
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    usageLimit: r.usage_limit,
    usedCount: r.used_count,
    status: r.status,
    usedAt: r.used_at,
    usedOrderId: r.used_order_id,
    inStoreTable: r.in_store_table,
    createdAt: r.created_at,
  };
}

export interface MessageRow {
  id: number;
  campaign_id: number;
  campaign_type: CampaignType;
  campaign_year: number | null;
  customer_id: string;
  customer_name: string | null;
  phone_number: string;
  template_name: string;
  template_language: string;
  template_params: string[];
  rendered_body: string;
  coupon_id: number | null;
  whatsapp_message_id: string | null;
  status: MessageStatus;
  attempts: number;
  scheduled_for: Date | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  read_at: Date | null;
  failed_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
}

export function discountText(type: DiscountType, value: number): string {
  if (type === 'PERCENT') return `${stripZeros(value)}%`;
  return `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function stripZeros(v: number): string {
  return String(Number(Number(v).toFixed(2)));
}
