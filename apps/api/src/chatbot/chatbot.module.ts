import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChatbotController } from './chatbot.controller';
import { ChatbotService } from './chatbot.service';
import { ChatbotRetrieval } from './chatbot.retrieval';
import { ChatbotIdentityGuard } from './chatbot.identity';
import { PrismaModule } from '../prisma/prisma.module';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [ConfigModule, PrismaModule, JwtModule.register({})],
  controllers: [ChatbotController],
  providers: [ChatbotService, ChatbotRetrieval, ChatbotIdentityGuard],
})
export class ChatbotModule {}
