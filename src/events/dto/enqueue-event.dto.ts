import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ArrayMaxSize,
} from 'class-validator';
import { Transform } from 'class-transformer';

export const META_ENQUEUE_EVENT_NAMES = [
  'ViewContent',
  'Lead',
  'Schedule',
  'LeadSubmitted',
  'AddToWishlist',
  'Purchase',
] as const;

export type MetaEnqueueEventName = (typeof META_ENQUEUE_EVENT_NAMES)[number];

export class EnqueueEventDto {
  @IsIn([...META_ENQUEUE_EVENT_NAMES])
  event_name!: MetaEnqueueEventName;

  @IsString()
  @MaxLength(200)
  idempotency_key!: string;

  @IsOptional()
  @IsUUID('4')
  event_id?: string;

  @IsOptional()
  @IsInt()
  @Min(1_000_000_000)
  @Max(2_000_000_000)
  event_time?: number;

  @IsIn(['website', 'system_generated', 'business_messaging', 'other', 'chat'])
  action_source!:
    | 'website'
    | 'system_generated'
    | 'business_messaging'
    | 'other'
    | 'chat';

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  event_source_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  last_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  full_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  external_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  fbp?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  fbc?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  fbclid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  client_ip_address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  client_user_agent?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  content_ids?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(256)
  content_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  content_category?: string;

  /** Subtipo interno La Vilet (no va a Graph). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  lv_internal_subtype?: string;

  @IsOptional()
  @IsUUID('4')
  unit_id?: string;

  /** Cierre comercial (Purchase). Idempotency FE: purchase:{sale_id}. */
  @IsOptional()
  @IsUUID('4')
  sale_id?: string;

  /** Importe Purchase (Meta custom_data.value). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  value?: number;

  /** ISO-4217; obligatorio para Purchase. No inventar. */
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  messaging_channel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  ctwa_clid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  whatsapp_business_account_id?: string;

  /** Dataset messaging Graph (≠ WABA). Si falta, no usar pixel web para BM. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  messaging_dataset_id?: string;

  @IsOptional()
  @IsIn(['test', 'live'])
  delivery_lane?: 'test' | 'live';

  @IsOptional()
  @IsString()
  @MaxLength(128)
  visitor_key?: string;

  @IsOptional()
  @IsUUID('4')
  lead_id?: string;

  /** Alcance CRM (LeadSubmitted); no van a Graph. */
  @IsOptional()
  @IsUUID('4')
  tenant_id?: string;

  @IsOptional()
  @IsUUID('4')
  project_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  contact_id?: string;

  @Transform(({ value }) => value === true || value === 'true' || value === 1)
  @IsBoolean()
  ads_consent!: boolean;
}
