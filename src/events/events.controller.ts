import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InternalSecretGuard } from '../auth/auth.module';
import { EventsService } from './events.service';
import { EnqueueEventDto } from './dto/enqueue-event.dto';

@Controller('v1/events')
@UseGuards(InternalSecretGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /**
   * Lookup de trazabilidad por event_id (SQLite Nest).
   * Devuelve estado + evidencia Graph redacted si existe. No reenvía.
   */
  @Get(':eventId')
  lookup(@Param('eventId') eventId: string) {
    return this.events.lookupByEventId(eventId);
  }

  /** Encola un evento. Requiere secreto interno. */
  @Post()
  @HttpCode(202)
  enqueue(@Body() body: EnqueueEventDto) {
    return this.events.enqueue(body);
  }
}
