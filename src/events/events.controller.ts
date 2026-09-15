import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { InternalSecretGuard } from '../auth/auth.module';
import { EventsService } from './events.service';
import { EnqueueEventDto } from './dto/enqueue-event.dto';

@Controller('v1/events')
@UseGuards(InternalSecretGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /** Encola un evento. Requiere secreto interno. */
  @Post()
  @HttpCode(202)
  enqueue(@Body() body: EnqueueEventDto) {
    return this.events.enqueue(body);
  }
}
