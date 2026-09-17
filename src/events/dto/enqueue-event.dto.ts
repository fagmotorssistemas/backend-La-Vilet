import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ArrayMaxSize,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class EnqueueEventDto {
  @IsIn(['ViewContent', 'Lead', 'Schedule'])
  event_name!: 'ViewContent' | 'Lead' | 'Schedule';

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
    'website' | 'system_generated' | 'business_messaging' | 'other' | 'chat';

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

  @Transform(({ value }) => value === true || value === 'true' || value === 1)
  @IsBoolean()
  ads_consent!: boolean;
}
