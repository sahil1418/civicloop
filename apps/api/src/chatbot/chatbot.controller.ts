import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ChatbotService } from './chatbot.service';
import { ChatRequestDto } from './chatbot.dto';
import { ChatbotIdentityGuard } from './chatbot.identity';
import type { ChatHttpRequest } from './chatbot.identity';

@Controller('chatbot')
@UseGuards(ThrottlerGuard, ChatbotIdentityGuard)
export class ChatbotController {
  constructor(private readonly chatbot: ChatbotService) {}

  @Get('status')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  status(@Req() req: ChatHttpRequest) {
    return this.chatbot.status(req.chatActor);
  }

  @Post('messages')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 8, ttl: 60000, blockDuration: 60000 } })
  reply(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: ChatRequestDto,
    @Req() req: ChatHttpRequest,
  ) {
    return this.chatbot.reply(body.messages, req.chatActor);
  }
}
